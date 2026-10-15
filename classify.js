const CATEGORIES = ['fire', 'police', 'medical', 'child_services', 'other'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

// Simple keyword fallback used only if the AI call fails (e.g. no API key set,
// or the network/API is unavailable). Keeps the app usable in a degraded mode
// rather than failing the whole submission.
function keywordFallback(message) {
  const text = message.toLowerCase();
  let category = 'other';
  let severity = 'medium';

  if (/(fire|smoke|burning|explosion)/.test(text)) category = 'fire';
  else if (/(robbery|assault|weapon|gun|knife|break.?in|theft|suspicious)/.test(text)) category = 'police';
  else if (/(injured|bleeding|unconscious|heart attack|accident|ambulance|not breathing)/.test(text)) category = 'medical';
  else if (/(child|minor|abuse|neglect|unsafe home)/.test(text)) category = 'child_services';

  if (/(critical|dying|not breathing|explosion|life.?threatening)/.test(text)) severity = 'critical';
  else if (/(urgent|serious|badly|weapon|gun)/.test(text)) severity = 'high';
  else if (/(minor|small|not urgent)/.test(text)) severity = 'low';

  return {
    category,
    severity,
    summary: message.slice(0, 140),
    location: null,
    confidence: 0.3,
    ai_notes: 'Classified by keyword fallback (AI classification unavailable).',
  };
}

async function classifyIncident(message) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return keywordFallback(message);
  }

  const systemPrompt = `You are an incident triage assistant for an emergency reporting system.
Given a raw message from a member of the public, extract structured incident data.

Respond ONLY with a single JSON object, no markdown, no commentary, matching exactly this shape:
{
  "category": one of ${JSON.stringify(CATEGORIES)},
  "severity": one of ${JSON.stringify(SEVERITIES)},
  "summary": "a clear one-sentence summary of the incident, written for a dispatcher",
  "location": "a location string if one is mentioned or inferable, otherwise null",
  "confidence": a number between 0 and 1 for how confident you are in this classification,
  "ai_notes": "one short sentence flagging anything a human operator should double check, or null"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!response.ok) {
      console.error('Anthropic API error', response.status, await response.text());
      return keywordFallback(message);
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) return keywordFallback(message);

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      category: CATEGORIES.includes(parsed.category) ? parsed.category : 'other',
      severity: SEVERITIES.includes(parsed.severity) ? parsed.severity : 'medium',
      summary: parsed.summary || message.slice(0, 140),
      location: parsed.location || null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      ai_notes: parsed.ai_notes || null,
    };
  } catch (err) {
    console.error('Classification failed, using keyword fallback:', err.message);
    return keywordFallback(message);
  }
}

module.exports = { classifyIncident, CATEGORIES, SEVERITIES };
