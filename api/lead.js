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
    return res.status(500).json({ success: false, message: "Lead service is not configured." });
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
    const upstream = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ ...lead, _token: secret }),
      redirect: "follow"
    });

    const responseText = await upstream.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (_) {
      result = null;
    }

    if (!upstream.ok || !result || result.status !== "success") {
      // Do not expose the upstream response or any submitted personal data.
      return res.status(502).json({ success: false, message: "We couldn't confirm saving your enquiry." });
    }

    return res.status(200).json({ success: true });
  } catch (_) {
    return res.status(502).json({ success: false, message: "We couldn't reach the lead service." });
  }
};
