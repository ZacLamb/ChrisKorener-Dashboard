CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  ghl_contact_id TEXT UNIQUE NOT NULL,
  name TEXT,
  email TEXT,
  phone TEXT,
  tags TEXT[] DEFAULT '{}',
  source TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  ghl_conversation_id TEXT UNIQUE NOT NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  contact_name TEXT,
  channel TEXT,
  unread_count INTEGER DEFAULT 0,
  assigned_to TEXT,
  last_message_body TEXT,
  last_message_direction TEXT,
  last_message_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel);
CREATE INDEX IF NOT EXISTS idx_conversations_assigned ON conversations(assigned_to);
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg ON conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  ghl_message_id TEXT UNIQUE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT,
  channel TEXT,
  body TEXT,
  status TEXT,
  created_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS summaries (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary TEXT,
  sentiment TEXT,
  action_needed BOOLEAN DEFAULT false,
  model TEXT,
  summarized_message_count INTEGER,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_log (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  conversations_synced INTEGER DEFAULT 0,
  messages_synced INTEGER DEFAULT 0,
  status TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  overview TEXT,
  stats JSONB,
  status TEXT DEFAULT 'done',
  error TEXT,
  resummarized INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
-- Safe to re-run: adds these columns if this table already existed from an earlier deploy.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'done';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resummarized INTEGER DEFAULT 0;
