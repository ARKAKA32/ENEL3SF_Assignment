require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { classifyIncident } = require('./classify');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Service role key — server-side ONLY. Never expose this to the browser.
// This is what lets the classification service write category/severity
// back onto a row that RLS otherwise only lets staff update.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Step 3 of the sequence diagram: civilian's report is already inserted
// (done client-side via the anon key, per RLS policy "anyone can submit
// incidents"); this endpoint enriches that row with AI classification.
app.post('/api/classify', async (req, res) => {
  const { incident_id, message } = req.body;
  if (!incident_id || !message) {
    return res.status(400).json({ error: 'incident_id and message are required' });
  }

  try {
    const result = await classifyIncident(message);

    const { data, error } = await supabase
      .from('incidents')
      .update({
        category: result.category,
        severity: result.severity,
        title: result.title,
        updated_at: new Date().toISOString(),
      })
      .eq('incident_id', incident_id)
      .select()
      .single();

    if (error) throw error;

    if (result.ai_notes) {
      await supabase.from('incident_updates').insert({
        incident_id,
        update_type: 'NOTE',
        note: result.ai_notes,
      });
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Classification failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ai: !!process.env.ANTHROPIC_API_KEY,
    supabase: !!process.env.SUPABASE_URL,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sentry server running at http://localhost:${PORT}`);
  if (!process.env.SUPABASE_URL) console.log('WARNING: SUPABASE_URL not set.');
  if (!process.env.ANTHROPIC_API_KEY) console.log('No ANTHROPIC_API_KEY set — using keyword fallback.');
});
