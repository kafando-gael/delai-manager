CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  due_date TEXT NOT NULL,
  note TEXT,
  repetition TEXT NOT NULL DEFAULT 'none'
    CHECK (repetition IN ('none', 'monthly', 'yearly')),
  reminder_day INTEGER NOT NULL DEFAULT 1,
  reminder_week INTEGER NOT NULL DEFAULT 1,
  reminder_month INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
