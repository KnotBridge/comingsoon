// Agent Journey: a ready-made Outreach flow that walks a real-estate agent
// from your cold email to a paid conversion.
//
// DESIGN (why it's built this way):
//  - Branch on CLICKS + real in-app state, never on opens. Apple/Gmail make
//    "opened" unreliable in both directions; clicks and state (signed up /
//    staged / paid) are ground truth.
//  - Cold phase = strangers, deliverability is fragile. Two click-or-stop
//    touches, then PARK 3 weeks and try once more. Never hammer non-clickers.
//  - Warm phase = they clicked / they're in the app. Now we can do more,
//    because engagement protects deliverability and every message matches
//    their real state.
//  - No fake scarcity. The free window isn't actually enforced, so urgency is
//    honest: tied to selling THEIR listing, "I'll keep it loaded", reply-to-me.
//  - The engine hard-stops the whole flow the moment they reply or convert.
//
// FRAMING: we never pre-stage anyone. Photos are uploaded and waiting; staging
// (= an edited render) happens only when the agent hits Stage.
//
// STYLE: no em dashes anywhere in the copy (reads as an AI tell). Plain
// periods and commas. Helvetica 20px, whitespace, plain underlined links.
//
// Vars at send: {{first_name}} {{street_address}} {{city}} {{days_on_market}}
// {{dynamic_page_url}}  (intro reuses your real "PropStream Real Estate USA 6")

const BODY_STYLE =
  "margin:0;padding:0;background-color:#ffffff;font-family:Helvetica,Arial,sans-serif;color:rgb(0,0,0);font-size:20px;font-weight:400;line-height:28px;";

const P = (inner: string, mb = 24) =>
  `<p style="margin:0 0 ${mb}px 0;font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:400;line-height:28px;color:rgb(0,0,0);">${inner}</p>`;

const LINK = (label: string) =>
  `<a href="{{dynamic_page_url}}" style="color:#000000;text-decoration:underline;">${label}</a>`;

const wrapEmail = (inner: string) =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n</head>\n` +
  `<body style="${BODY_STYLE}">\n<div style="max-width:620px;margin:0;padding:32px 28px;">\n${inner}\n</div>\n</body>\n</html>`;

// Each follow-up ends with this marker; the generator swaps it for the exact
// signature pulled live off your PropStream template (image and all), falling
// back to the text signature below if that template can't be read.
export const SIG_MARK = "__SIGNATURE__";
export const FALLBACK_SIG =
  P("Justin H.", 4) +
  P("Founder &amp; Head of Growth, Renov AI", 4) +
  P("Cluj-Napoca, Cluj 400482", 4) +
  P("+40 748 338 544", 4) +
  P(`<a href="https://renov.space" style="color:#000000;text-decoration:underline;">renov.space</a>`);

export interface JourneyTemplate { key: string; name: string; subject: string; body_html: string }

// Templates, in journey order (intro is reused, not created).
export const AGENT_JOURNEY_TEMPLATES: JourneyTemplate[] = [
  {
    // COLD #2. They didn't click the intro. Job: get the click. The proof lives
    // on the page, not crammed into the email, so we sell the look, not claims.
    key: "proof",
    name: "Agent journey · 2 See it (no click)",
    subject: "your {{street_address}} listing, before & after",
    body_html: wrapEmail(
      P("Hey {{first_name}},") +
      P("Quick follow-up on your {{street_address}} listing.") +
      P("Easiest thing is to just see it. I set up a page where your rooms go from empty to fully staged.") +
      P("Ten seconds to look. Nothing to install.") +
      P(LINK("See your listing staged →")) +
      SIG_MARK,
    ),
  },
  {
    // COLD #3, after a 3-week park. Fresh, low-key, honest (the listing may have
    // sold, so we hedge with "if it's still on the market").
    key: "retouch",
    name: "Agent journey · 3 Re-touch (3 weeks later)",
    subject: "circling back on {{street_address}}",
    body_html: wrapEmail(
      P("Hey {{first_name}},") +
      P("Circling back. I still have your {{street_address}} photos loaded in our staging tool.") +
      P("If it's still on the market, staged photos tend to pull more showings.") +
      P("Want to see how it looks? One click.") +
      P(LINK("Show me the staged version →")) +
      SIG_MARK,
    ),
  },
  {
    // WARM. They clicked but didn't claim. Friction + trust at the signup step.
    // Kill it: 20 seconds, no card, you own the images. Let the page do the rest.
    key: "seepage",
    name: "Agent journey · 4 Clicked, no signup",
    subject: "20 seconds to see {{street_address}} staged",
    body_html: wrapEmail(
      P("Hey {{first_name}},") +
      P("You took a look. Here's how to actually see your {{street_address}} fully staged.") +
      P("Claiming takes about 20 seconds. No card.") +
      P("Hit stage and the whole listing comes back done in a minute. The images are yours. Use them on MLS, Zillow, anywhere.") +
      P(LINK("See mine staged →")) +
      SIG_MARK,
    ),
  },
  {
    // WARM, hottest lead. Signed up, didn't stage. One button stands between
    // them and the aha. Single clear action.
    key: "stage",
    name: "Agent journey · 5 Press stage",
    subject: "your photos are loaded, {{first_name}}",
    body_html: wrapEmail(
      P("Hey {{first_name}},") +
      P("You're in. Your {{street_address}} photos are already uploaded.") +
      P("The only thing left is one button.") +
      P("Hit stage, and in about 60 seconds every room is done.") +
      P(LINK("Open your project and stage →")) +
      SIG_MARK,
    ),
  },
  {
    // WARM. Still didn't stage. Second, softer nudge that also invites a reply
    // (a reply = a real human signal + it lifts deliverability).
    key: "stage2",
    name: "Agent journey · 6 Stage nudge 2",
    subject: "one button, {{first_name}}",
    body_html: wrapEmail(
      P("Hey {{first_name}},") +
      P("Didn't want this to slip. Your {{street_address}} photos are sitting in your account ready to go.") +
      P("It's genuinely one click. 60 seconds and you'll see the whole listing staged.") +
      P("If something's not working, just reply and I'll sort it out.") +
      P(LINK("Stage my listing →")) +
      SIG_MARK,
    ),
  },
  {
    // WARM. They staged a photo, so they've felt the value. Reinforce + expand.
    key: "ready",
    name: "Agent journey · 7 Staged (use it)",
    subject: "{{street_address}} is staged",
    body_html: wrapEmail(
      P("Nice work, {{first_name}}.") +
      P("Your {{street_address}} is staged and saved in your account.") +
      P("Drop the shots on the MLS today. They're yours to use anywhere.") +
      P("Got more rooms, or other listings sitting on market? Same one button.") +
      P(LINK("Open your staged photos →")) +
      SIG_MARK,
    ),
  },
];

// Fallback intro, only used if "PropStream Real Estate USA 6" isn't found.
// Faithful to it, with honest (non-deadline) urgency since the free window
// isn't enforced.
export const INTRO_FALLBACK: JourneyTemplate = {
  key: "intro",
  name: "Agent journey · 1 Intro",
  subject: "re: {{first_name}}, question about {{street_address}}",
  body_html: wrapEmail(
    P("Hey {{first_name}},") +
    P("I'm Justin. I built an AI staging tool used by top-producing agents across the US to close listings 73% faster at 10% higher prices.") +
    P("That's NAR data, not my claim.") +
    P("I came across your listing at {{street_address}} which was sitting {{days_on_market}} days on market, so I went ahead and uploaded the listing photos into our tool.") +
    P("It reads every image, every angle, any type of property. Upload the whole folder, hit stage, the entire listing is done automatically.") +
    P("Right now it's sitting there waiting for you. Just claim your account and hit stage. In 60 seconds you'll see your whole listing transformed.") +
    P("I'll keep it loaded for you. Free to try, no rush.") +
    P(LINK("Claim here your free staging →")) +
    P("Justin H.") +
    P("Founder &amp; Head of Growth, Renov AI", 4) +
    P("P.S. If AI staging has felt random before, it's because it was. Ours stages based on demographic data for that exact market. Everything matching what buyers are already looking for in that zip code."),
  ),
};

/* ── Graph ──────────────────────────────────────────────────────────────
   COLD: intro → (click?) → see-it → park 3w → re-touch → (click?) → stop.
   WARM (any click): signed up? → staged? → paid? Each "no" gets the matched
   nudge, re-checks real state, then advances or ends. Opens never branch.
   idByKey must contain: intro, proof, retouch, seepage, stage, stage2, ready
   (intro = your PropStream template id). */
export function buildAgentJourney(idByKey: Record<string, string>) {
  const intro = (id: string, label: string, position: { x: number; y: number }) =>
    ({ id, type: "email", label, position, config: { templateId: idByKey["intro"] || "", subject: "re: {{first_name}}, question about {{street_address}}" } });
  const email = (id: string, label: string, key: string, subject: string, position: { x: number; y: number }) =>
    ({ id, type: "email", label, position, config: { templateId: idByKey[key] || "", subject } });
  const wait = (id: string, label: string, amount: number, unit: string, position: { x: number; y: number }) =>
    ({ id, type: "wait", label, position, config: { amount, unit } });
  const cond = (id: string, label: string, conditionKey: string, conditionLabel: string, position: { x: number; y: number }) =>
    ({ id, type: "condition", label, position, config: { conditionKey, conditionLabel } });
  const goal = (id: string, label: string, position: { x: number; y: number }) =>
    ({ id, type: "action", label, position, config: { label } });

  const T = AGENT_JOURNEY_TEMPLATES.reduce((m, t) => (m[t.key] = t.subject, m), {} as Record<string, string>);

  const nodes = [
    { id: "t", type: "trigger", label: "Audience enrolled", position: { x: 480, y: 0 }, config: { triggerKey: "manual_enroll", triggerLabel: "Manually enrolled (pick an audience)" } },
    intro("e_intro", "1 · Intro (PropStream)", { x: 480, y: 100 }),
    wait("w_intro", "Wait 3 days", 3, "days", { x: 480, y: 190 }),
    // ── COLD ──
    cond("c_click1", "Clicked?", "clicked", "Clicked a link?", { x: 480, y: 280 }),
    email("e_proof", "2 · See it", "proof", T.proof, { x: 200, y: 380 }),
    wait("w_proof", "Wait 3 days", 3, "days", { x: 200, y: 470 }),
    cond("c_click2", "Clicked?", "clicked", "Clicked a link?", { x: 200, y: 560 }),
    wait("w_park", "Park 3 weeks", 21, "days", { x: 200, y: 650 }),
    email("e_retouch", "3 · Re-touch", "retouch", T.retouch, { x: 200, y: 740 }),
    wait("w_retouch", "Wait 5 days", 5, "days", { x: 200, y: 830 }),
    cond("c_click3", "Clicked?", "clicked", "Clicked a link?", { x: 200, y: 920 }),
    goal("g_cold_stop", "Stopped: no clicks", { x: 20, y: 1010 }),
    // ── WARM ──
    cond("c_signup", "Signed up?", "signed_up", "Signed up / claimed?", { x: 480, y: 1010 }),
    email("e_seepage", "4 · Clicked, no signup", "seepage", T.seepage, { x: 840, y: 1110 }),
    wait("w_seepage", "Wait 3 days", 3, "days", { x: 840, y: 1200 }),
    cond("c_signup2", "Signed up now?", "signed_up", "Signed up / claimed?", { x: 840, y: 1290 }),
    goal("g_warm_stop", "Stopped: never claimed", { x: 1080, y: 1380 }),
    cond("c_staged", "Staged?", "staged", "Staged a photo?", { x: 480, y: 1160 }),
    email("e_stage", "5 · Press stage", "stage", T.stage, { x: 200, y: 1260 }),
    wait("w_stage", "Wait 2 days", 2, "days", { x: 200, y: 1350 }),
    cond("c_staged2", "Staged now?", "staged", "Staged a photo?", { x: 200, y: 1440 }),
    email("e_stage2", "6 · Stage nudge 2", "stage2", T.stage2, { x: 200, y: 1530 }),
    wait("w_stage2", "Wait 3 days", 3, "days", { x: 200, y: 1620 }),
    cond("c_staged3", "Staged now?", "staged", "Staged a photo?", { x: 200, y: 1710 }),
    goal("g_stage_stop", "Stopped: never staged", { x: 20, y: 1800 }),
    email("e_ready", "7 · Staged", "ready", T.ready, { x: 480, y: 1310 }),
    wait("w_ready", "Wait 2 days", 2, "days", { x: 480, y: 1400 }),
    cond("c_conv", "Upgraded / paid?", "converted", "Upgraded / paid?", { x: 480, y: 1490 }),
    goal("g_won", "Converted 🎉", { x: 720, y: 1580 }),
    goal("g_end", "End of journey", { x: 480, y: 1690 }),
  ];

  const e = (id: string, source: string, target: string, handle?: "yes" | "no") =>
    ({ id, source, target, sourceHandle: handle ?? null, label: handle ? handle.toUpperCase() : null });

  const edges = [
    e("x1", "t", "e_intro"),
    e("x2", "e_intro", "w_intro"),
    e("x3", "w_intro", "c_click1"),
    // cold
    e("x4", "c_click1", "c_signup", "yes"),
    e("x5", "c_click1", "e_proof", "no"),
    e("x6", "e_proof", "w_proof"),
    e("x7", "w_proof", "c_click2"),
    e("x8", "c_click2", "c_signup", "yes"),
    e("x9", "c_click2", "w_park", "no"),
    e("x10", "w_park", "e_retouch"),
    e("x11", "e_retouch", "w_retouch"),
    e("x12", "w_retouch", "c_click3"),
    e("x13", "c_click3", "c_signup", "yes"),
    e("x14", "c_click3", "g_cold_stop", "no"),
    // warm: signup
    e("x15", "c_signup", "c_staged", "yes"),
    e("x16", "c_signup", "e_seepage", "no"),
    e("x17", "e_seepage", "w_seepage"),
    e("x18", "w_seepage", "c_signup2"),
    e("x19", "c_signup2", "c_staged", "yes"),
    e("x20", "c_signup2", "g_warm_stop", "no"),
    // warm: staged
    e("x21", "c_staged", "e_ready", "yes"),
    e("x22", "c_staged", "e_stage", "no"),
    e("x23", "e_stage", "w_stage"),
    e("x24", "w_stage", "c_staged2"),
    e("x25", "c_staged2", "e_ready", "yes"),
    e("x26", "c_staged2", "e_stage2", "no"),
    e("x27", "e_stage2", "w_stage2"),
    e("x28", "w_stage2", "c_staged3"),
    e("x29", "c_staged3", "e_ready", "yes"),
    e("x30", "c_staged3", "g_stage_stop", "no"),
    // warm: convert
    e("x31", "e_ready", "w_ready"),
    e("x32", "w_ready", "c_conv"),
    e("x33", "c_conv", "g_won", "yes"),
    e("x34", "c_conv", "g_end", "no"),
  ];

  return { name: "Agent journey", nodes, edges };
}
