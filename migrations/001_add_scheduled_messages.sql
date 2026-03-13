-- Создание таблицы для запланированных сообщений
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  message_text TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индекс для быстрого поиска pending сообщений
CREATE INDEX IF NOT EXISTS idx_scheduled_pending 
  ON scheduled_messages(scheduled_at) 
  WHERE status = 'pending';

-- Добавление новых настроек
INSERT INTO settings (key, value) VALUES
  ('admin_phone', ''),
  ('followup_enabled', 'false'),
  ('followup_delay_hours', '24'),
  ('followup_message', '')
ON CONFLICT (key) DO NOTHING;
