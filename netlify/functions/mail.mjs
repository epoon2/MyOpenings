/*
  EMAIL

  One thing sends mail: a new session request, to the address in the
  calendar's settings. Delivery goes through Brevo's transactional API
  with the key and verified sender from the environment:

    BREVO_API_KEY       the API key from Brevo (SMTP & API -> API Keys)
    NOTIFY_FROM_EMAIL   a sender address verified in Brevo
    BREVO_API_BASE      optional, for tests

  Without both, mail is simply off: requests still arrive in the
  admin's list, nothing is sent, and the settings dialog says so. A
  failed send never fails the request that caused it - it is logged
  and remembered so the admin banner can say the notification did not
  go out.
*/

const DEFAULT_API_BASE =
  "https://api.brevo.com/v3";

const SEND_TIMEOUT_MS =
  8000;

export function mailSettings(env = process.env) {
  const apiKey = env.BREVO_API_KEY;
  const from = env.NOTIFY_FROM_EMAIL;
  if (!apiKey || !from) return null;
  return {
    apiKey,
    from,
    apiBase: env.BREVO_API_BASE || DEFAULT_API_BASE
  };
}

export function mailConfigured(env = process.env) {
  return Boolean(mailSettings(env));
}

/*
  Send one message. Throws with a readable reason on any failure, so
  the caller decides what to do with it.
*/
export async function sendMail({ to, subject, text, html, fromName, replyTo }, env = process.env) {
  const settings = mailSettings(env);
  if (!settings) throw new Error("Email is not configured (BREVO_API_KEY and NOTIFY_FROM_EMAIL are needed).");
  if (!to) throw new Error("No address to send to.");
  const body = {
    sender: { name: fromName || "Availability", email: settings.from },
    to: [{ email: to }],
    ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    subject,
    textContent: text,
    ...(html ? { htmlContent: html } : {})
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${settings.apiBase}/smtp/email`, {
      method: "POST",
      headers: {
        "api-key": settings.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(error.name === "AbortError" ? "Brevo did not answer in time." : `Brevo could not be reached: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      detail = data.message || data.code || JSON.stringify(data);
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new Error(`Brevo ${response.status}: ${detail}`.trim());
  }
  const data = await response.json().catch(() => ({}));
  return { messageId: data.messageId || null };
}


/*
  THE REQUEST NOTIFICATION

  Everything the admin needs to act on the request, and a link to the
  page where it waits. Times are the calendar's own wall-clock times,
  so they read exactly as the requester saw them.
*/

export function requestNotification({ request, config, siteUrl }) {
  const title = config.portalTitle || "Availability";
  const when = describeWhen(request);
  const noun = (config.labels && config.labels.person) || "student";
  const lines = [
    `A ${noun} has requested a session on ${title}.`,
    "",
    `Name:     ${request.name}`,
    ...(request.guardian ? [`Guardian: ${request.guardian}`] : []),
    ...(request.email ? [`Email:    ${request.email}`] : []),
    ...(request.phone ? [`Phone:    ${request.phone}`] : []),
    `Subject:  ${request.subject}`,
    `Format:   ${request.format}`,
    `When:     ${when}`,
    ...(request.recurrence ? [`Repeats:  ${describeRecurrence(request.recurrence)}`] : []),
    "",
    siteUrl ? `Review it under Requests: ${siteUrl}` : "Review it under Requests on the admin page.",
    ...(request.email ? [`Reply to this email to answer ${request.name} directly.`] : []),
    "",
    `Sent by ${title}. You can change or turn off these emails in Settings.`
  ];
  const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const row = (label, value) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">${label}</td><td style="padding:4px 0">${escape(value)}</td></tr>`;
  const html = [
    `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111827">`,
    `<p>A ${escape(noun)} has requested a session on <strong>${escape(title)}</strong>.</p>`,
    `<table style="border-collapse:collapse">`,
    row("Name", request.name),
    request.guardian ? row("Guardian", request.guardian) : "",
    request.email ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">Email</td><td style="padding:4px 0"><a href="mailto:${escape(request.email)}">${escape(request.email)}</a></td></tr>` : "",
    request.phone ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">Phone</td><td style="padding:4px 0"><a href="tel:${escape(request.phone.replace(/[^0-9+]/g, ""))}">${escape(request.phone)}</a></td></tr>` : "",
    row("Subject", request.subject), row("Format", request.format), row("When", when),
    request.recurrence ? row("Repeats", describeRecurrence(request.recurrence)) : "",
    `</table>`,
    siteUrl ? `<p><a href="${escape(siteUrl)}" style="color:#2f56d9">Review it under Requests</a></p>` : `<p>Review it under Requests on the admin page.</p>`,
    request.email ? `<p>Reply to this email to answer ${escape(request.name)} directly.</p>` : "",
    `<p style="color:#6b7280;font-size:13px">Sent by ${escape(title)}. You can change or turn off these emails in Settings.</p>`,
    `</div>`
  ].join("");
  return {
    subject: `New session request from ${request.name} - ${when}`,
    text: lines.join("\n"),
    html
  };
}

export function describeWhen(request) {
  const start = request.start || "";
  const end = request.end || "";
  const day = start.slice(0, 10);
  const date = new Date(day + "T12:00:00Z");
  const dayLabel = Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${dayLabel}, ${clock(start.slice(11, 16))} - ${clock(end.slice(11, 16))}`;
}

function clock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h)) return hhmm;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function describeRecurrence(recurrence) {
  if (!recurrence || recurrence.frequency !== "WEEKLY") return "no";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = (recurrence.weekdays || []).map((d) => names[d]).join(", ");
  const every = recurrence.interval > 1 ? `every ${recurrence.interval} weeks` : "weekly";
  const until = recurrence.endType === "ON" ? ` until ${recurrence.until}` : recurrence.endType === "COUNT" ? `, ${recurrence.count} times` : "";
  return `${every} on ${days}${until}`;
}


/*
  ACCOUNT EMAILS

  Two short messages for the sign-up flow: the link that proves an
  address is real, and the link that lets a forgotten password be
  replaced. Both links carry a code that works once and expires.
*/

const SIMPLE_STYLE =
  "font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111827";

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function verificationEmail({ displayName, link, siteName, hours }) {
  const site = siteName || "MyOpenings";
  const text = [
    `Hi ${displayName},`,
    "",
    `Confirm your email to publish your calendar on ${site}:`,
    link,
    "",
    `The link works for ${hours} hours. If you did not sign up, you can ignore this email.`
  ].join("\n");
  const html = [
    `<div style="${SIMPLE_STYLE}">`,
    `<p>Hi ${escapeHtml(displayName)},</p>`,
    `<p>Confirm your email to publish your calendar on ${escapeHtml(site)}:</p>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#2f56d9;color:#fff;border-radius:8px;text-decoration:none">Confirm my email</a></p>`,
    `<p style="color:#6b7280;font-size:13px">Or open this link: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a><br>`,
    `The link works for ${hours} hours. If you did not sign up, you can ignore this email.</p>`,
    `</div>`
  ].join("");
  return { subject: `Confirm your email for ${site}`, text, html };
}

export function resetEmail({ displayName, link, siteName, hours }) {
  const site = siteName || "MyOpenings";
  const text = [
    `Hi ${displayName},`,
    "",
    `Someone asked to reset the password for your account on ${site}. If that was you, choose a new one here:`,
    link,
    "",
    `The link works for ${hours} hours. If you did not ask for this, your password stays as it is.`
  ].join("\n");
  const html = [
    `<div style="${SIMPLE_STYLE}">`,
    `<p>Hi ${escapeHtml(displayName)},</p>`,
    `<p>Someone asked to reset the password for your account on ${escapeHtml(site)}. If that was you, choose a new one here:</p>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#2f56d9;color:#fff;border-radius:8px;text-decoration:none">Choose a new password</a></p>`,
    `<p style="color:#6b7280;font-size:13px">Or open this link: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a><br>`,
    `The link works for ${hours} hours. If you did not ask for this, your password stays as it is.</p>`,
    `</div>`
  ].join("");
  return { subject: `Reset your password for ${site}`, text, html };
}
