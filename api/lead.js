const MAX_BODY_CHARS = 10000;

function clean(value, limit) {
  return String(value == null ? "" : value).trim().slice(0, limit);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  // Same-origin browser requests are expected. This is a browser-side guard,
  // not a substitute for server-side validation or rate limiting.
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) {
        return res.status(403).json({ success: false, message: "Request origin not allowed." });
      }
    } catch (_) {
      return res.status(403).json({ success: false, message: "Request origin not allowed." });
    }
  }

  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  const secret = process.env.WEBHORIZN_API_SECRET;

  if (!scriptUrl || !secret) {
    return res.status(500).json({
      success: false,
      message: "Lead form setup is incomplete. Check both Vercel Production environment variables and redeploy."
    });
  }

  let body = req.body;
  try {
    if (typeof body === "string") {
      if (body.length > MAX_BODY_CHARS) {
        return res.status(413).json({ success: false, message: "Request too large." });
      }
      body = JSON.parse(body);
    } else if (body && typeof body === "object") {
      if (JSON.stringify(body).length > MAX_BODY_CHARS) {
        return res.status(413).json({ success: false, message: "Request too large." });
      }
    }
  } catch (_) {
    return res.status(400).json({ success: false, message: "Invalid request body." });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ success: false, message: "Invalid request body." });
  }

  const lead = {
    name: clean(body.name, 120),
    phone: clean(body.phone, 30),
    city: clean(body.city, 80),
    business: clean(body.business, 100),
    service: clean(body.service, 100),
    website_package: clean(body.website_package || "Not selected", 100),
    details: clean(body.details, 1200)
  };

  if (!lead.name || !lead.phone || !lead.city || !lead.business || !lead.service) {
    return res.status(400).json({ success: false, message: "Please complete all required fields." });
  }

  // The website validates Indian mobile numbers before submission; validate
  // again server-side because client-side checks can be bypassed.
  if (!/^[6-9]\d{9}$/.test(lead.phone)) {
    return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
  }

  try {
    // Send a URL-encoded payload so Apps Script can read it from e.parameter.
    const payload = JSON.stringify({ ...lead, _token: secret });
    const encodedBody = new URLSearchParams({ payload }).toString();

    const upstream = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: encodedBody,
      redirect: "follow"
    });

    const responseText = await upstream.text();
    const responseContentType = upstream.headers.get("content-type") || "unknown";
    const responseHost = (() => {
      try { return new URL(upstream.url).hostname; } catch (_) { return "unknown"; }
    })();

    let result;
    try {
      result = JSON.parse(responseText);
    } catch (_) {
      result = null;
    }

    if (!upstream.ok || !result || result.status !== "success") {
      if (!result) {
        // Safe diagnostics only: never return the raw response body or submitted lead.
        return res.status(502).json({
          success: false,
          message: "Google returned a non-JSON response (HTTP " + upstream.status +
            ", content type " + responseContentType + ", response host " + responseHost +
            "). Check the Apps Script deployment URL and web-app access settings."
        });
      }
      // Report a safe next step without exposing submitted data or stack traces.
      if (result && result.status === "error" && result.message === "Unauthorized.") {
        return res.status(502).json({
          success: false,
          message: "Google rejected the lead-service secret. Confirm WEBHORIZN_API_SECRET exactly matches the Apps Script Script Property, then redeploy the Apps Script and Vercel."
        });
      }
      if (result && result.status === "error" && result.message === "Configuration error: 'Leads' worksheet missing.") {
        return res.status(502).json({
          success: false,
          message: "Google could not find the Leads tab. Confirm the worksheet name is exactly Leads."
        });
      }
      if (result && result.status === "error") {
        return res.status(502).json({
          success: false,
          message: "Google received the submission but could not save it. Check Apps Script authorization, the deployed version, and the Leads tab."
        });
      }
      return res.status(502).json({
        success: false,
        message: "Google returned an unexpected response. Check the Apps Script web-app deployment and public access setting."
      });
    }

    return res.status(200).json({ success: true });
  } catch (_) {
    return res.status(502).json({
      success: false,
      message: "The website could not reach Google Apps Script. Check the web-app URL and deployment access."
    });
  }
};
