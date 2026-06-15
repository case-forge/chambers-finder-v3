export async function onRequestPost(context) {
    const { request, env } = context;
    // _headers does not apply to Pages Functions responses, so security and
    // cache headers must be set here.
    const jsonHeaders = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
    };

    try {
        const formData = await request.formData();
        const token = formData.get('cf-turnstile-response');

        if (!env.TURNSTILE_SECRET) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Server misconfiguration: missing Turnstile secret.'
            }), { status: 500, headers: jsonHeaders });
        }

        if (!token) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Missing security token. Please complete the verification check.'
            }), { status: 400, headers: jsonHeaders });
        }

        const ip = request.headers.get('CF-Connecting-IP') || 'anonymous';

        // Verify Turnstile first — don't burn rate limit on failed captchas
        const formDataToken = new FormData();
        formDataToken.append('secret', env.TURNSTILE_SECRET);
        formDataToken.append('response', token);
        formDataToken.append('remoteip', ip);

        const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            body: formDataToken,
            method: 'POST',
        });

        const outcome = await result.json();
        if (!outcome.success) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Security verification failed. Please try reloading the page.',
                code: 'CAPTCHA_FAILED'
            }), { status: 400, headers: jsonHeaders });
        }

        // IP rate limiting — 3 submissions per IP per hour
        if (env.RATE_LIMIT) {
            const kvKey = `cf_contact_${ip}`;
            const count = parseInt(await env.RATE_LIMIT.get(kvKey) || '0');
            if (count >= 3) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Too many requests. Please try again later.',
                    code: 'RATE_LIMITED'
                }), { status: 429, headers: jsonHeaders });
            }
            await env.RATE_LIMIT.put(kvKey, (count + 1).toString(), { expirationTtl: 3600 });
        }

        // Extract and validate fields
        const name    = String(formData.get('name')    || '').trim();
        const email   = String(formData.get('email')   || '').trim();
        const type    = String(formData.get('type')    || '').trim();
        const message = String(formData.get('message') || '').trim();

        // \p{L}\p{M} accepts accented and non-Latin letters (Zoë, José, Ó Briain);
        // ’ covers the curly apostrophe iOS keyboards produce.
        const nameRegex  = /^[\p{L}\p{M}\s\-'’.]+$/u;
        const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
        const allowedTypes = ['correction', 'suggestion', 'general', 'chambers-missing'];

        if (name.length < 2 || name.length > 80 || !nameRegex.test(name)) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Name must be 2 to 80 characters: letters, spaces, hyphens, apostrophes and full stops.'
            }), { status: 400, headers: jsonHeaders });
        }

        if (email.length < 3 || email.length > 100 || !emailRegex.test(email)) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Please enter a valid email address.'
            }), { status: 400, headers: jsonHeaders });
        }

        if (!allowedTypes.includes(type)) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Please select a valid message type.'
            }), { status: 400, headers: jsonHeaders });
        }

        if (message.length < 10 || message.length > 1000) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Message must be 10 to 1000 characters.'
            }), { status: 400, headers: jsonHeaders });
        }

        const recipientEmails = (env.CONTACT_RECIPIENTS || '')
            .split(',')
            .map(v => v.trim())
            .filter(Boolean);

        if (recipientEmails.length === 0) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Unable to send your message at this time. Please try again later.',
                code: 'NO_RECIPIENTS'
            }), { status: 500, headers: jsonHeaders });
        }

        const resendApiKey = (env.RESEND_API_KEY || '').trim();
        if (!resendApiKey) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Unable to send your message at this time. Please try again later.',
                code: 'RESEND_NOT_CONFIGURED'
            }), { status: 500, headers: jsonHeaders });
        }

        const fromEmail = (env.CONTACT_FROM_EMAIL || '').trim();
        const fromName  = (env.CONTACT_FROM_NAME  || 'Chambers Finder').trim();

        if (!fromEmail) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Unable to send your message at this time. Please try again later.',
                code: 'FROM_EMAIL_NOT_CONFIGURED'
            }), { status: 500, headers: jsonHeaders });
        }

        const escapeHTML = (str) => {
            if (typeof str !== 'string') return '';
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };

        const typeLabels = {
            correction:        'Data correction',
            suggestion:        'Suggestion',
            general:           'General enquiry',
            'chambers-missing': 'Missing chambers'
        };

        const safeName    = escapeHTML(name);
        const safeEmail   = escapeHTML(email);
        const safeMessage = escapeHTML(message);
        const safeType    = escapeHTML(typeLabels[type] || type);

        const emailBody = {
            from: `${fromName} <${fromEmail}>`,
            to: recipientEmails,
            reply_to: `${name} <${email}>`,
            // Subjects are plain text — HTML-escaping here would show literal
            // entities (O'Brien → O&#039;Brien). name/type are already validated.
            subject: `[Chambers Finder] ${typeLabels[type] || type}: ${name}`,
            text: `Type: ${typeLabels[type] || type}\nFrom: ${name} <${email}>\n\nMessage:\n${message}`,
            html: `
                <p><strong>Type:</strong> ${safeType}</p>
                <p><strong>From:</strong> ${safeName} &lt;<a href="mailto:${safeEmail}">${safeEmail}</a>&gt;</p>
                <hr>
                <p><strong>Message:</strong></p>
                <p>${safeMessage.replace(/\n/g, '<br>')}</p>
            `
        };

        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${resendApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(emailBody),
        });

        if (res.ok) {
            return new Response(JSON.stringify({
                success: true,
                redirect: '/success'
            }), { status: 200, headers: jsonHeaders });
        }

        const errorText = await res.text();
        let code = `RESEND_${res.status}`;
        if (res.status === 401) code = 'RESEND_401_BADKEY';
        if (res.status === 403) code = 'RESEND_403_UNAUTHORIZED';
        if (res.status === 422) code = 'RESEND_422_INVALID_PAYLOAD';

        console.error(`[contact] Resend error ${code}:`, errorText);
        return new Response(JSON.stringify({
            success: false,
            error: 'Unable to send your message at this time. Please try again later.',
            code
        }), { status: 500, headers: jsonHeaders });

    } catch (err) {
        console.error('[contact] Handler error:', err);
        return new Response(JSON.stringify({
            success: false,
            error: 'An unexpected error occurred. Please try again later.'
        }), { status: 500, headers: jsonHeaders });
    }
}

// Without these, non-POST requests fall through to static asset serving and
// get the 404 page; answer with an explicit 405 instead.
function methodNotAllowed() {
    return new Response(JSON.stringify({
        success: false,
        error: 'Method not allowed. Use POST.'
    }), {
        status: 405,
        headers: {
            'Content-Type': 'application/json',
            'Allow': 'POST, OPTIONS',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        }
    });
}

export const onRequestGet    = methodNotAllowed;
export const onRequestHead   = methodNotAllowed;
export const onRequestPut    = methodNotAllowed;
export const onRequestDelete = methodNotAllowed;
export const onRequestPatch  = methodNotAllowed;

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': 'https://caseforge.uk',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
        },
    });
}
