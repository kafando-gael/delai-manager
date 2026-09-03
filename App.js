import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  SectionList,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as SQLite from 'expo-sqlite';
import * as SplashScreen from 'expo-splash-screen';
import {Ionicons} from '@expo/vector-icons';
import {
  cancelDeadlineNotifications,
  configureNotifications,
  requestNotificationPermissions,
  scheduleDeadlineNotifications,
  syncAllDeadlineNotifications,
  NOTIF_ACTIONS,
  alertOptionsFromSettings,
  snoozeDeadlineNotification,
  subscribeNotificationActions,
} from './notifications';
import {
  TRIAL_DEADLINE_LIMIT,
  canAddDeadline,
  confirmSubscriptionPayment,
  cancelSubscriptionPayment,
  fetchSubscriptionStatus,
  isSubscriptionActive,
  mergeSubscriptionWithTrial,
  startSubscriptionPayment,
  syncClientProfile,
} from './subscription';
import {WebView} from 'react-native-webview';
import {
  LanguageProvider,
  ageRangeOptions,
  translate,
  useI18n,
} from './i18n';

SplashScreen.preventAutoHideAsync().catch(() => {});

const LOGO = require('./assets/app-logo.png');
const APP_NAME = 'OnTime';
const DAY_MS = 24 * 60 * 60 * 1000;
const SUBSCRIPTION_ANNUAL_FCFA = 1000;

const EMPTY_FORM = {
  title: '',
  dueDate: '',
  domain: '',
  note: '',
  repetition: 'none',
  reminderOffsets: [0, 1, 7],
  reminderHour: 9,
  reminderMinute: 0,
};

const REMINDER_PRESETS = [
  {days: 0, labelKey: 'reminderDayOf'},
  {days: 1, labelKey: 'reminder1Day'},
  {days: 3, labelKey: 'reminder3Days'},
  {days: 7, labelKey: 'reminder1Week'},
  {days: 14, labelKey: 'reminder2Weeks'},
  {days: 30, labelKey: 'reminder1Month'},
];

const TIME_OPTIONS = [
  {hour: 7, minute: 0, label: '07:00'},
  {hour: 8, minute: 0, label: '08:00'},
  {hour: 9, minute: 0, label: '09:00'},
  {hour: 12, minute: 0, label: '12:00'},
  {hour: 18, minute: 0, label: '18:00'},
  {hour: 20, minute: 0, label: '20:00'},
];

const PRESET_OFFSET_DAYS = new Set(REMINDER_PRESETS.map(preset => preset.days));
const DEFAULT_REMINDER_OFFSETS = [0, 1, 7];

const ONBOARDING_SLIDES = [
  {
    titleKey: 'onboarding1Title',
    copyKey: 'onboarding1Copy',
    image: require('./assets/onboarding-1-deadlines.png'),
  },
  {
    titleKey: 'onboarding2Title',
    copyKey: 'onboarding2Copy',
    image: require('./assets/onboarding-2-reminders.png'),
  },
  {
    titleKey: 'onboarding3Title',
    copyKey: 'onboarding3Copy',
    image: require('./assets/onboarding-3-local.png'),
  },
];

function generateDeviceId() {
  return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isPlaceholderEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return !value || value.endsWith('@delaimanager.local') || value.endsWith('@ontime.local');
}

function isValidEmail(email) {
  const value = String(email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !isPlaceholderEmail(value);
}

function isPaymentReturnUrl(url) {
  if (!url) {
    return false;
  }
  const lower = url.toLowerCase();
  return lower.includes('payment/return')
    || lower.includes('purpose=subscription')
    || lower.includes('status=success')
    || lower.includes('status=cancelled');
}

function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBefore(value) {
  const date = parseDate(value);
  if (!date) {
    return 0;
  }
  return Math.ceil((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / DAY_MS);
}

function formatDate(value, locale = 'fr-FR') {
  const date = parseDate(value);
  if (!date) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function distanceLabel(value, t) {
  const days = daysBefore(value);
  if (days < 0) {
    return t('sinceDays', {count: Math.abs(days)});
  }
  if (days === 0) {
    return t('todayLower');
  }
  if (days === 1) {
    return t('tomorrow');
  }
  return t('inDays', {count: days});
}

const C = {
  blue: '#2563EB',
  orange: '#f97316',
  red: '#dc2626',
  green: '#16a34a',
  bg: '#F8FAFC',
  card: '#FFFFFF',
  dark: '#0f172a',
  mid: '#64748b',
  light: '#94a3b8',
  border: '#e2e8f0',
};

function statusFor(deadline, settings, t) {
  const days = daysBefore(deadline.dueDate);
  if (days < 0) {
    return {id: 'expired', label: t ? t('overdue') : 'En retard', color: C.red, barColor: C.red};
  }
  if (days <= settings.criticalDays) {
    return {id: 'critical', label: t ? t('urgent') : 'Urgent', color: C.orange, barColor: C.orange};
  }
  if (days <= settings.watchDays) {
    return {id: 'watch', label: t ? t('upcoming') : 'A venir', color: C.blue, barColor: C.blue};
  }
  return {id: 'ok', label: t ? t('upToDate') : 'A jour', color: C.green, barColor: C.blue};
}

function urgencyProgress(dueDate, settings) {
  const days = daysBefore(dueDate);
  if (days < 0) {return 1;}
  if (days >= settings.watchDays) {return 0.06;}
  return Math.max(0.06, 1 - days / settings.watchDays);
}

function domainIconName(domain) {
  const d = (domain || '').toLowerCase();
  if (d.includes('voiture') || d.includes('auto') || d.includes('transport')) {return 'car-outline';}
  if (d.includes('maison') || d.includes('loyer') || d.includes('logement')) {return 'home-outline';}
  if (d.includes('sant') || d.includes('medecin') || d.includes('docteur')) {return 'medkit-outline';}
  if (d.includes('travail') || d.includes('bureau') || d.includes('etude') || d.includes('etud')) {return 'briefcase-outline';}
  if (d.includes('identite') || d.includes('passeport') || d.includes('visa') || d.includes('admin')) {return 'document-text-outline';}
  if (d.includes('famille') || d.includes('enfant')) {return 'people-outline';}
  if (d.includes('banque') || d.includes('finance') || d.includes('impot')) {return 'card-outline';}
  return 'calendar-outline';
}

function nextDate(dueDate, repetition) {
  const date = parseDate(dueDate);
  if (!date) {
    return dueDate;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Keep advancing until the new date is strictly in the future
  if (repetition === 'monthly') {
    do {
      date.setMonth(date.getMonth() + 1);
    } while (date <= today);
  } else if (repetition === 'yearly') {
    do {
      date.setFullYear(date.getFullYear() + 1);
    } while (date <= today);
  }
  // 'none' = one-time, no new date needed (caller should delete instead)
  return date.toISOString().slice(0, 10);
}

function repetitionLabel(value, t) {
  if (value === 'monthly') {
    return t('monthly');
  }
  if (value === 'yearly') {
    return t('yearly');
  }
  return t('none');
}

function remindersLabel(item, t) {
  const offsets = item.reminderOffsets || [];
  if (!offsets.length) {
    return t('remindersOff');
  }
  const time = formatReminderTime(item.reminderHour ?? 9, item.reminderMinute ?? 0);
  return t('remindersSummary', {
    time,
    list: offsets.map(days => offsetLabel(days, t)).join(', '),
  });
}

function offsetLabel(days, t) {
  if (days === 0) {
    return t('reminderDayOf');
  }
  if (days === 1) {
    return t('reminder1Day');
  }
  if (days === 3) {
    return t('reminder3Days');
  }
  if (days === 7) {
    return t('reminder1Week');
  }
  if (days === 14) {
    return t('reminder2Weeks');
  }
  if (days === 30) {
    return t('reminder1Month');
  }
  return t('daysBeforeLabel', {count: days});
}

function formatReminderTime(hour, minute) {
  return `${String(hour).padStart(2, '0')}h${String(minute).padStart(2, '0')}`;
}

function parseReminderOffsets(value, row) {
  if (value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map(Number).filter(n => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b);
      }
    } catch {
      // fall through to legacy migration
    }
  }
  const legacy = [];
  if (row?.reminder_day) {
    legacy.push(1);
  }
  if (row?.reminder_week) {
    legacy.push(7);
  }
  if (row?.reminder_month) {
    legacy.push(30);
  }
  if (legacy.length) {
    return [...new Set([0, ...legacy])].sort((a, b) => a - b);
  }
  return [...DEFAULT_REMINDER_OFFSETS];
}

function getCustomOffsets(offsets) {
  return offsets.filter(days => !PRESET_OFFSET_DAYS.has(days));
}

function isSameTime(a, hour, minute) {
  return a.hour === hour && a.minute === minute;
}

function defaultForm(settings) {
  return {
    ...EMPTY_FORM,
    reminderOffsets: [...(settings.defaultReminderOffsets || DEFAULT_REMINDER_OFFSETS)],
    reminderHour: settings.defaultReminderHour ?? 9,
    reminderMinute: settings.defaultReminderMinute ?? 0,
  };
}

function mapDeadlineToForm(deadline) {
  return {
    id: deadline.id,
    title: deadline.title,
    dueDate: deadline.dueDate,
    domain: deadline.domain || '',
    note: deadline.note || '',
    repetition: deadline.repetition || 'none',
    reminderOffsets: [...(deadline.reminderOffsets || DEFAULT_REMINDER_OFFSETS)],
    reminderHour: deadline.reminderHour ?? 9,
    reminderMinute: deadline.reminderMinute ?? 0,
  };
}

function isSameMonth(dateKey, year, month) {
  const date = parseDate(dateKey);
  return date && date.getFullYear() === year && date.getMonth() === month;
}

function dateParts(value) {
  const date = parseDate(value);
  if (!date) {
    return {day: '--', month: '---'};
  }
  return {
    day: String(date.getDate()),
    month: new Intl.DateTimeFormat('fr-FR', {month: 'short'})
      .format(date)
      .replace('.', '')
      .toUpperCase(),
  };
}

function toDateKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function buildCalendarGrid(year, month) {
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(day);
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  return cells;
}

function monthLabel(year, month, locale = 'fr-FR') {
  return new Intl.DateTimeFormat(locale, {month: 'long', year: 'numeric'}).format(new Date(year, month, 1));
}

function groupDeadlinesForHome(deadlines, settings, t) {
  const groups = [
    {id: 'expired', title: t('sectionOverdue'), items: []},
    {id: 'critical', title: t('sectionUrgent'), items: []},
    {id: 'upcoming', title: t('sectionUpcoming'), items: []},
  ];

  for (const item of deadlines) {
    const status = statusFor(item, settings, t);
    if (status.id === 'expired') {
      groups[0].items.push(item);
    } else if (status.id === 'critical') {
      groups[1].items.push(item);
    } else {
      groups[2].items.push(item);
    }
  }

  return groups.filter(group => group.items.length > 0);
}

function mapDeadline(row) {
  return {
    id: String(row.id),
    title: row.title,
    domain: row.category || '',
    dueDate: row.due_date,
    note: row.note || '',
    repetition: row.repetition,
    reminderOffsets: parseReminderOffsets(row.reminder_offsets, row),
    reminderHour: row.reminder_hour ?? 9,
    reminderMinute: row.reminder_minute ?? 0,
  };
}

export default function App() {
  const [db, setDb] = useState(null);
  const [ready, setReady] = useState(false);
  const [activeTab, setActiveTab] = useState('home');
  const [profile, setProfile] = useState(null);
  const [settings, setSettings] = useState({
    criticalDays: 3,
    watchDays: 14,
    introCompleted: false,
    notificationsEnabled: true,
    defaultReminderHour: 9,
    defaultReminderMinute: 0,
    defaultReminderOffsets: [...DEFAULT_REMINDER_OFFSETS],
    language: 'fr',
    strongAlertsEnabled: true,
  });
  const [deadlines, setDeadlines] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [accessForm, setAccessForm] = useState({
    name: '',
    email: '',
    usageReason: '',
    ageRange: '',
    termsAccepted: false,
  });
  const [onboardingSlide, setOnboardingSlide] = useState(0);
  const [selectedDeadline, setSelectedDeadline] = useState(null);
  const [deviceId, setDeviceId] = useState('');
  const [subscription, setSubscription] = useState({
    isActive: false,
    endsAt: null,
    daysLeft: 0,
    annualPriceFcfa: SUBSCRIPTION_ANNUAL_FCFA,
    freeDeadlineLimit: TRIAL_DEADLINE_LIMIT,
    isTrialActive: false,
    trialDaysLeft: 0,
    trialEndsAt: null,
    trialStartedAt: null,
    deadlineLimit: TRIAL_DEADLINE_LIMIT,
  });
  const [trialStartedAt, setTrialStartedAt] = useState(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState(null);
  const [pendingPaymentId, setPendingPaymentId] = useState(null);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const ctxRef = useRef({});

  useEffect(() => {
    let mounted = true;

    async function boot() {
      await configureNotifications();
      const database = await SQLite.openDatabaseAsync('gestionnaire-delai.db');
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS profile (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          name TEXT NOT NULL,
          access_hint TEXT NOT NULL,
          access_code TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          critical_days INTEGER NOT NULL DEFAULT 3,
          watch_days INTEGER NOT NULL DEFAULT 14,
          privacy_lock INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS deadlines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          due_date TEXT NOT NULL,
          note TEXT,
          repetition TEXT NOT NULL DEFAULT 'none',
          reminder_day INTEGER NOT NULL DEFAULT 1,
          reminder_week INTEGER NOT NULL DEFAULT 1,
          reminder_month INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await ensureProfileColumns(database);
      await ensureAppSettingsColumns(database);
      await ensureDeadlineColumns(database);

      await database.runAsync(
        `INSERT OR IGNORE INTO app_settings
          (id, critical_days, watch_days, privacy_lock, intro_completed)
         VALUES (1, 3, 14, 0, 0)`,
      );

      const settingsRow = await database.getFirstAsync('SELECT * FROM app_settings WHERE id = 1');
      let nextDeviceId = settingsRow?.device_id;
      if (!nextDeviceId) {
        nextDeviceId = generateDeviceId();
        await database.runAsync('UPDATE app_settings SET device_id = ? WHERE id = 1', nextDeviceId);
      }

      await removeSampleDeadlines(database);

      if (mounted) {
        setDb(database);
        setDeviceId(nextDeviceId);
        const loaded = await loadData(database, nextDeviceId);
        setReady(true);
        await SplashScreen.hideAsync();
        if (loaded?.notificationsEnabled) {
          requestNotificationPermissions()
            .then(async granted => {
              if (!granted) {
                return;
              }
              const alerts = alertOptionsFromSettings(loaded.settings);
              await configureNotifications(alerts.language);
              await syncAllDeadlineNotifications(loaded.deadlines, true, alerts);
            })
            .catch(() => {});
        }
      }
    }

    boot().catch(async error => {
      await SplashScreen.hideAsync();
      Alert.alert(
        translate('fr', 'loadError'),
        translate('fr', 'cannotLoadApp', {app: APP_NAME, error: error.message}),
      );
    });

    return () => {
      mounted = false;
    };
  }, []);

  async function syncClientToServer(profileData, deviceIdValue = deviceId) {
    if (!deviceIdValue || !profileData?.name) {
      return;
    }
    try {
      await syncClientProfile({
        deviceId: deviceIdValue,
        name: profileData.name,
        email: profileData.email,
        phone: profileData.phone || '',
        usageReason: profileData.usageReason || '',
        ageRange: profileData.ageRange || '',
      });
    } catch (error) {
      console.warn('[syncClient]', error.message);
    }
  }

  async function syncSubscription(deviceIdValue = deviceId, trialStartedAtValue = trialStartedAt) {
    if (!deviceIdValue) {
      return null;
    }
    try {
      const remote = await fetchSubscriptionStatus(deviceIdValue);
      const status = mergeSubscriptionWithTrial(remote, trialStartedAtValue);
      setSubscription(status);
      if (db) {
        await db.runAsync(
          'UPDATE app_settings SET subscription_ends_at = ?, subscription_active = ? WHERE id = 1',
          status.endsAt || null,
          status.isActive ? 1 : 0,
        );
      }
      return status;
    } catch {
      const localOnly = mergeSubscriptionWithTrial(null, trialStartedAtValue);
      setSubscription(localOnly);
      return localOnly;
    }
  }

  async function loadData(database = db, deviceIdValue = deviceId) {
    if (!database) {
      return null;
    }
    const profileRow = await database.getFirstAsync('SELECT * FROM profile WHERE id = 1');
    const settingsRow = await database.getFirstAsync('SELECT * FROM app_settings WHERE id = 1');
    const rows = await database.getAllAsync('SELECT * FROM deadlines ORDER BY due_date ASC, title ASC');
    const mappedDeadlines = rows.map(mapDeadline);

    if (profileRow) {
      let email = profileRow.email || '';
      if (isPlaceholderEmail(email)) {
        email = '';
        await database.runAsync(`UPDATE profile SET email = '' WHERE id = 1`);
      }
      const nextProfile = {
        name: profileRow.name,
        email,
        phone: profileRow.phone || '',
        usageReason: profileRow.usage_reason || '',
        ageRange: profileRow.age_range || '',
        termsAccepted: Boolean(profileRow.terms_accepted),
      };
      setProfile(nextProfile);
      syncClientToServer(nextProfile, deviceIdValue);
    } else {
      setProfile(null);
    }
    let introCompleted = Boolean(settingsRow?.intro_completed);
    if (profileRow && !introCompleted) {
      await database.runAsync('UPDATE app_settings SET intro_completed = 1 WHERE id = 1');
      introCompleted = true;
    }

    let nextTrialStartedAt = settingsRow?.trial_started_at || null;
    if (profileRow && !nextTrialStartedAt) {
      nextTrialStartedAt = profileRow.created_at || new Date().toISOString();
      await database.runAsync(
        'UPDATE app_settings SET trial_started_at = ? WHERE id = 1',
        nextTrialStartedAt,
      );
    }
    setTrialStartedAt(nextTrialStartedAt);

    const nextSettings = {
      criticalDays: settingsRow?.critical_days ?? 3,
      watchDays: settingsRow?.watch_days ?? 14,
      introCompleted,
      notificationsEnabled: settingsRow?.notifications_enabled !== 0,
      defaultReminderHour: settingsRow?.default_reminder_hour ?? 9,
      defaultReminderMinute: settingsRow?.default_reminder_minute ?? 0,
      defaultReminderOffsets: parseReminderOffsets(settingsRow?.default_reminder_offsets, null),
      language: settingsRow?.language === 'en' ? 'en' : 'fr',
      strongAlertsEnabled: settingsRow?.strong_alerts !== 0,
    };
    setSettings(nextSettings);
    setDeadlines(mappedDeadlines);
    setSubscription(mergeSubscriptionWithTrial(null, nextTrialStartedAt));
    // Don't block app open on API — sync in background.
    syncSubscription(deviceIdValue, nextTrialStartedAt).catch(() => {});
    return {
      deadlines: mappedDeadlines,
      notificationsEnabled: nextSettings.notificationsEnabled,
      settings: nextSettings,
    };
  }

  const sortedDeadlines = useMemo(
    () => [...deadlines].sort((a, b) => parseDate(a.dueDate) - parseDate(b.dueDate)),
    [deadlines],
  );

  const stats = useMemo(() => {
    return {
      upcoming: deadlines.filter(item => daysBefore(item.dueDate) >= 0).length,
      critical: deadlines.filter(item => statusFor(item, settings).id === 'critical').length,
      expired: deadlines.filter(item => statusFor(item, settings).id === 'expired').length,
    };
  }, [deadlines, settings]);

  const language = settings.language === 'en' ? 'en' : 'fr';
  const locale = language === 'en' ? 'en-US' : 'fr-FR';
  const t = useMemo(() => (key, params) => translate(language, key, params), [language]);

  async function completeIntro() {
    await db.runAsync('UPDATE app_settings SET intro_completed = 1 WHERE id = 1');
    setSettings(current => ({...current, introCompleted: true}));
    setOnboardingSlide(0);
  }

  async function createProfile() {
    const name = accessForm.name.trim();
    const ageRange = accessForm.ageRange;
    if (!name) {
      Alert.alert(t('missingInfo'), t('enterName'));
      return;
    }
    if (!ageRange) {
      Alert.alert(t('missingInfo'), t('selectAge'));
      return;
    }
    if (!accessForm.termsAccepted) {
      Alert.alert(t('termsRequired'), t('acceptTermsAlert'));
      return;
    }
    const email = accessForm.email.trim();
    if (email && !isValidEmail(email)) {
      Alert.alert(t('invalidEmail'), t('fixEmailOrEmpty'));
      return;
    }
    const trialStart = new Date().toISOString();
    await db.runAsync(
      `INSERT OR REPLACE INTO profile
        (id, name, access_hint, access_code, email, phone, usage_reason, age_range, terms_accepted)
       VALUES (1, ?, '', '', ?, '', '', ?, 1)`,
      name,
      email,
      ageRange,
    );
    await db.runAsync('UPDATE app_settings SET trial_started_at = ? WHERE id = 1', trialStart);
    setTrialStartedAt(trialStart);
    const nextProfile = {
      name,
      email,
      phone: '',
      usageReason: '',
      ageRange,
      termsAccepted: true,
    };
    await syncClientToServer(nextProfile);
    await loadData();
    Alert.alert(
      t('freeTrialTitle'),
      t('freeTrialBody', {
        name,
        limit: TRIAL_DEADLINE_LIMIT,
        price: SUBSCRIPTION_ANNUAL_FCFA.toLocaleString(locale),
      }),
      [{text: t('understood')}],
    );
  }

  function updateForm(field, value) {
    if (typeof field === 'object') {
      setForm(current => ({...current, ...field}));
      return;
    }
    setForm(current => ({...current, [field]: value}));
  }

  async function saveDeadline() {
    if (!form.title.trim()) {
      Alert.alert(t('titleRequired'), t('addTitle'));
      return;
    }
    if (!parseDate(form.dueDate)) {
      Alert.alert(t('invalidDate'), t('chooseDueDate'));
      return;
    }
    if (!form.id && !canAddDeadline(deadlines.length, subscription)) {
      setShowPaywall(true);
      return;
    }

    const offsets = form.reminderOffsets;
    const record = {
      title: form.title.trim(),
      domain: form.domain.trim(),
      dueDate: form.dueDate,
      note: form.note.trim(),
      repetition: form.repetition,
      reminderHour: form.reminderHour,
      reminderMinute: form.reminderMinute,
    };

    let deadlineId = form.id;

    if (form.id) {
      await db.runAsync(
        `UPDATE deadlines
         SET title = ?, category = ?, due_date = ?, note = ?, repetition = ?,
             reminder_offsets = ?, reminder_hour = ?, reminder_minute = ?
         WHERE id = ?`,
        record.title,
        record.domain,
        record.dueDate,
        record.note,
        record.repetition,
        JSON.stringify(offsets),
        record.reminderHour,
        record.reminderMinute,
        form.id,
      );
    } else {
      const result = await db.runAsync(
        `INSERT INTO deadlines
          (title, category, due_date, note, repetition, reminder_offsets, reminder_hour, reminder_minute)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        record.title,
        record.domain,
        record.dueDate,
        record.note,
        record.repetition,
        JSON.stringify(offsets),
        record.reminderHour,
        record.reminderMinute,
      );
      deadlineId = String(result.lastInsertRowId);
    }

    if (settings.notificationsEnabled) {
      const granted = await requestNotificationPermissions();
      if (granted) {
        await scheduleDeadlineNotifications({
          id: String(deadlineId),
          title: record.title,
          dueDate: record.dueDate,
          reminderOffsets: offsets,
          reminderHour: record.reminderHour,
          reminderMinute: record.reminderMinute,
        }, alertOptionsFromSettings(settings));
      }
    }

    setForm(defaultForm(settings));
    setSelectedDeadline(null);
    await loadData();
    setActiveTab('home');
  }

  async function renewDeadline(deadline) {
    const renewedDate = nextDate(deadline.dueDate, deadline.repetition);
    await db.runAsync('UPDATE deadlines SET due_date = ? WHERE id = ?', renewedDate, deadline.id);
    const renewed = {...deadline, dueDate: renewedDate};
    if (settings.notificationsEnabled) {
      await scheduleDeadlineNotifications(renewed, alertOptionsFromSettings(settings));
    }
    await loadData();
    setSelectedDeadline(renewed);
  }

  async function deleteDeadline(deadline) {
    await cancelDeadlineNotifications(deadline.id);
    await db.runAsync('DELETE FROM deadlines WHERE id = ?', deadline.id);
    setSelectedDeadline(null);
    await loadData();
  }

  async function updateSettings(patch) {
    const next = {...settings, ...patch};
    await db.runAsync(
      `UPDATE app_settings
       SET critical_days = ?, watch_days = ?, notifications_enabled = ?,
           default_reminder_hour = ?, default_reminder_minute = ?, default_reminder_offsets = ?,
           language = ?, strong_alerts = ?
       WHERE id = 1`,
      next.criticalDays,
      next.watchDays,
      next.notificationsEnabled ? 1 : 0,
      next.defaultReminderHour,
      next.defaultReminderMinute,
      JSON.stringify(next.defaultReminderOffsets),
      next.language === 'en' ? 'en' : 'fr',
      next.strongAlertsEnabled === false ? 0 : 1,
    );
    setSettings(next);
    const shouldResync =
      'notificationsEnabled' in patch
      || 'strongAlertsEnabled' in patch
      || 'criticalDays' in patch
      || 'language' in patch;
    if (shouldResync) {
      await configureNotifications(next.language);
      if (next.notificationsEnabled) {
        const granted = await requestNotificationPermissions();
        if (granted) {
          await syncAllDeadlineNotifications(deadlines, true, alertOptionsFromSettings(next));
        }
      } else if ('notificationsEnabled' in patch) {
        await syncAllDeadlineNotifications(deadlines, false);
      }
    }
  }

  ctxRef.current = {db, settings, loadData};

  useEffect(() => {
    if (!ready) {
      return undefined;
    }
    return subscribeNotificationActions(async (action, data) => {
      const {db: database, settings: currentSettings, loadData: reload} = ctxRef.current;
      const deadlineId = data?.deadlineId;
      if (!database || !deadlineId) {
        return;
      }
      const row = await database.getFirstAsync('SELECT * FROM deadlines WHERE id = ?', deadlineId);
      if (!row) {
        return;
      }
      const deadline = mapDeadline(row);
      const alerts = alertOptionsFromSettings(currentSettings);

      if (action === NOTIF_ACTIONS.SNOOZE) {
        await snoozeDeadlineNotification(deadline, 10, alerts);
        return;
      }
      if (action === NOTIF_ACTIONS.POSTPONE) {
        const date = parseDate(deadline.dueDate);
        if (!date) {
          return;
        }
        date.setDate(date.getDate() + 1);
        const nextDue = toDateKey(date.getFullYear(), date.getMonth(), date.getDate());
        await database.runAsync('UPDATE deadlines SET due_date = ? WHERE id = ?', nextDue, deadline.id);
        if (currentSettings.notificationsEnabled) {
          await scheduleDeadlineNotifications({...deadline, dueDate: nextDue}, alerts);
        }
        await reload();
        return;
      }
      if (action === NOTIF_ACTIONS.MARK_DONE) {
        if (deadline.repetition !== 'none') {
          const renewedDate = nextDate(deadline.dueDate, deadline.repetition);
          await database.runAsync('UPDATE deadlines SET due_date = ? WHERE id = ?', renewedDate, deadline.id);
          if (currentSettings.notificationsEnabled) {
            await scheduleDeadlineNotifications({...deadline, dueDate: renewedDate}, alerts);
          }
        } else {
          await cancelDeadlineNotifications(deadline.id);
          await database.runAsync('DELETE FROM deadlines WHERE id = ?', deadline.id);
        }
        await reload();
      }
    });
  }, [ready]);

  function openDeadline(item) {
    setSelectedDeadline(item);
  }

  function openEditDeadline(deadline) {
    setForm(mapDeadlineToForm(deadline));
    setSelectedDeadline(null);
    setActiveTab('add');
  }

  function openAddDeadline() {
    if (!canAddDeadline(deadlines.length, subscription)) {
      setShowPaywall(true);
      return;
    }
    setForm(defaultForm(settings));
    setActiveTab('add');
  }

  async function updateProfileEmail(nextEmail) {
    const email = String(nextEmail || '').trim();
    if (!isValidEmail(email)) {
      Alert.alert(t('invalidEmail'), t('enterValidEmail'));
      return false;
    }
    if (!db || !profile) {
      return false;
    }
    await db.runAsync('UPDATE profile SET email = ? WHERE id = 1', email);
    const nextProfile = {...profile, email};
    setProfile(nextProfile);
    await syncClientToServer(nextProfile);
    return true;
  }

  async function beginSubscriptionPayment() {
    setPaymentLoading(true);
    try {
      if (!isValidEmail(profile?.email)) {
        setShowPaywall(false);
        Alert.alert(t('emailRequiredPay'), t('emailRequiredPayBody'));
        return;
      }
      const result = await startSubscriptionPayment({
        deviceId,
        customerEmail: profile.email.trim(),
        customerName: profile?.name || t('userFallback'),
        customerPhone: profile?.phone || '',
        usageReason: profile?.usageReason || '',
        ageRange: profile?.ageRange || '',
      });
      if (!result.paymentUrl) {
        throw new Error(t('cannotStartPayment'));
      }
      setPendingPaymentId(result.paymentId);
      setPaymentUrl(result.paymentUrl);
      setShowPaywall(false);
    } catch (error) {
      Alert.alert(t('payment'), error.message || t('cannotStartPayment'));
    } finally {
      setPaymentLoading(false);
    }
  }

  async function finishSubscriptionPayment(cancelled = false) {
    const paymentId = pendingPaymentId;
    if (cancelled) {
      try {
        if (paymentId) {
          await cancelSubscriptionPayment(deviceId, paymentId);
        }
      } catch (error) {
        console.warn('[cancelPayment]', error.message);
      }
      setPaymentUrl(null);
      setPendingPaymentId(null);
      return;
    }

    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (paymentId) {
        await confirmSubscriptionPayment(deviceId, paymentId);
      }
      const status = await syncSubscription();
      setPaymentUrl(null);
      setPendingPaymentId(null);
      if (isSubscriptionActive(status)) {
        Alert.alert(t('subscriptionActive'), t('subscriptionActiveBody'));
      } else {
        Alert.alert(t('paymentPending'), t('paymentPendingBody'));
      }
    } catch {
      setPaymentUrl(null);
      setPendingPaymentId(null);
      Alert.alert(t('verification'), t('cannotConfirmPayment'));
    }
  }

  function withI18n(node) {
    return (
      <LanguageProvider
        language={language}
        setLanguage={lang => updateSettings({language: lang === 'en' ? 'en' : 'fr'})}
      >
        {node}
      </LanguageProvider>
    );
  }

  if (!ready) {
    return withI18n(<LoadingScreen />);
  }

  if (!settings.introCompleted) {
    return withI18n(
      <OnboardingScreen
        slide={onboardingSlide}
        onNext={() => {
          if (onboardingSlide < ONBOARDING_SLIDES.length - 1) {
            setOnboardingSlide(current => current + 1);
            return;
          }
          completeIntro();
        }}
        onSkip={completeIntro}
      />,
    );
  }

  if (!profile) {
    return withI18n(
      <AccessScreen
        accessForm={accessForm}
        setAccessForm={setAccessForm}
        createProfile={createProfile}
      />,
    );
  }

  const todayLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date());

  return withI18n(
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
      <View style={styles.appShell}>
        <View style={styles.appHeader}>
          <View style={styles.appHeaderBrand}>
            <Image source={LOGO} style={styles.appHeaderLogo} />
            <Text style={styles.appHeaderName}>{APP_NAME}</Text>
          </View>
          <Pressable style={styles.appHeaderAction} onPress={() => setActiveTab('settings')}>
            <Ionicons name="settings-outline" size={24} color="#64748b" />
          </Pressable>
        </View>
        <View style={styles.content}>
          {activeTab === 'home' ? (
            <HomeScreen
              profile={profile}
              stats={stats}
              deadlines={sortedDeadlines}
              settings={settings}
              todayLabel={todayLabel}
              onPressDeadline={openDeadline}
              onAdd={openAddDeadline}
              onOpenCalendar={() => setActiveTab('calendar')}
            />
          ) : null}
          {activeTab === 'calendar' ? (
            <CalendarScreen
              deadlines={sortedDeadlines}
              settings={settings}
              onPressDeadline={openDeadline}
            />
          ) : null}
          {activeTab === 'add' ? (
            <AddScreen
              form={form}
              settings={settings}
              updateForm={updateForm}
              saveDeadline={saveDeadline}
              onCancel={() => {
                setForm(defaultForm(settings));
                setActiveTab('home');
              }}
            />
          ) : null}
          {activeTab === 'settings' ? (
            <SettingsScreen
              profile={profile}
              settings={settings}
              stats={stats}
              deadlines={deadlines}
              subscription={subscription}
              updateSettings={updateSettings}
              onSubscribe={() => setShowPaywall(true)}
              onRefreshSubscription={() => syncSubscription()}
              onUpdateEmail={updateProfileEmail}
            />
          ) : null}
        </View>

        <View style={styles.tabBar}>
          <TabButton id="home" label={t('tabHome')} icon="home" activeTab={activeTab} setActiveTab={setActiveTab} />
          <TabButton id="calendar" label={t('tabCalendar')} icon="calendar" activeTab={activeTab} setActiveTab={setActiveTab} />
          <View style={styles.fabWrapper}>
            <Pressable style={styles.fab} onPress={openAddDeadline}>
              <Ionicons name="add" size={24} color="#ffffff" />
              <Text style={styles.fabLabel}>{t('fabNew')}</Text>
            </Pressable>
          </View>
          <TabButton id="settings" label={t('tabSettings')} icon="settings" activeTab={activeTab} setActiveTab={setActiveTab} />
        </View>
      </View>

      <DeadlineModal
        deadline={selectedDeadline}
        settings={settings}
        close={() => setSelectedDeadline(null)}
        onEdit={openEditDeadline}
        renewDeadline={renewDeadline}
        deleteDeadline={deleteDeadline}
      />

      <SubscriptionPaywallModal
        visible={showPaywall}
        subscription={subscription}
        loading={paymentLoading}
        onClose={() => setShowPaywall(false)}
        onSubscribe={beginSubscriptionPayment}
      />

      <SubscriptionPaymentModal
        paymentUrl={paymentUrl}
        onClose={() => finishSubscriptionPayment(true)}
        onComplete={finishSubscriptionPayment}
      />
    </SafeAreaView>
  );
}

function LoadingScreen() {
  const {t} = useI18n();
  return (
    <SafeAreaView style={styles.loadingScreen}>
      <View style={styles.loadingBrand}>
        <Image source={LOGO} style={styles.loadingLogo} />
        <Text style={styles.loadingBrandName}>{APP_NAME}</Text>
      </View>
      <ActivityIndicator color={C.blue} style={{marginTop: 28}} />
      <Text style={styles.loadingText}>{t('loading')}</Text>
    </SafeAreaView>
  );
}

function OnboardingScreen({slide, onNext, onSkip}) {
  const {t} = useI18n();
  const current = ONBOARDING_SLIDES[slide];
  const isLast = slide === ONBOARDING_SLIDES.length - 1;

  return (
    <SafeAreaView style={styles.onboardingScreen}>
      <StatusBar barStyle="dark-content" backgroundColor="#F8FAFC" />
      <View style={styles.onboardingTopBar}>
        <Pressable onPress={onSkip}>
          <Text style={styles.onboardingSkip}>{t('skip')}</Text>
        </Pressable>
      </View>

      <View style={styles.onboardingBody}>
        <Image source={current.image} style={styles.onboardingIllustration} />
        <Text style={styles.onboardingTitle}>{t(current.titleKey)}</Text>
        <Text style={styles.onboardingCopy}>{t(current.copyKey)}</Text>
      </View>

      <View style={styles.onboardingFooter}>
        <View style={styles.onboardingDots}>
          {ONBOARDING_SLIDES.map((_, index) => (
            <View key={index} style={[styles.onboardingDot, index === slide && styles.onboardingDotActive]} />
          ))}
        </View>
        <PrimaryButton label={isLast ? t('start') : t('next')} onPress={onNext} />
      </View>
    </SafeAreaView>
  );
}

function AccessScreen(props) {
  const {t} = useI18n();
  return (
    <SafeAreaView style={styles.accessScreen}>
      <StatusBar barStyle="dark-content" backgroundColor="#F8FAFC" />
      <ScrollView contentContainerStyle={styles.accessScroll} keyboardShouldPersistTaps="handled">
        <View style={styles.accessPanel}>
          <Image source={LOGO} style={styles.accessLogo} />
          <Text style={styles.accessTitle}>{t('welcomeTitle', {app: APP_NAME})}</Text>
          <Text style={styles.accessCopy}>{t('welcomeCopy')}</Text>
          <View style={styles.trialBanner}>
            <Text style={styles.trialBannerTitle}>{t('trialBannerTitle')}</Text>
            <Text style={styles.trialBannerCopy}>
              {t('trialBannerCopy', {limit: TRIAL_DEADLINE_LIMIT})}
            </Text>
          </View>

          <Input
            label={t('yourName')}
            value={props.accessForm.name}
            onChangeText={value => props.setAccessForm(current => ({...current, name: value}))}
          />
          <Input
            label={t('emailOptional')}
            value={props.accessForm.email}
            placeholder={t('emailPlaceholder')}
            keyboardType="email-address"
            autoCapitalize="none"
            onChangeText={value => props.setAccessForm(current => ({...current, email: value}))}
          />
          <Dropdown
            label={t('ageRange')}
            value={props.accessForm.ageRange}
            options={ageRangeOptions(t)}
            placeholder={t('agePlaceholder')}
            onChange={value => props.setAccessForm(current => ({...current, ageRange: value}))}
          />
          <TermsRow
            accepted={props.accessForm.termsAccepted}
            onToggle={() =>
              props.setAccessForm(current => ({...current, termsAccepted: !current.termsAccepted}))
            }
          />
          <PrimaryButton label={t('enterApp', {app: APP_NAME})} onPress={props.createProfile} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CalendarScreen({deadlines, settings, onPressDeadline}) {
  const {t, locale} = useI18n();
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState(toDateKey(today.getFullYear(), today.getMonth(), today.getDate()));

  const deadlinesByDate = useMemo(() => {
    const map = {};
    for (const item of deadlines) {
      if (!map[item.dueDate]) {
        map[item.dueDate] = [];
      }
      map[item.dueDate].push(item);
    }
    return map;
  }, [deadlines]);

  const monthDeadlines = useMemo(
    () => deadlines
      .filter(item => isSameMonth(item.dueDate, viewYear, viewMonth))
      .sort((a, b) => parseDate(a.dueDate) - parseDate(b.dueDate)),
    [deadlines, viewYear, viewMonth],
  );

  const grid = useMemo(() => buildCalendarGrid(viewYear, viewMonth), [viewYear, viewMonth]);
  const selectedDeadlines = deadlinesByDate[selectedDate] || [];
  const weekdayLabels = locale.startsWith('en')
    ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    : ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  function shiftMonth(delta) {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  }

  function goToToday() {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    setSelectedDate(toDateKey(today.getFullYear(), today.getMonth(), today.getDate()));
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.calendarContent}>
      <View style={styles.calendarHeaderRow}>
        <Text style={styles.pageTitle}>{t('calendar')}</Text>
        <Pressable style={styles.calendarTodayButton} onPress={goToToday}>
          <Text style={styles.calendarTodayButtonText}>{t('today')}</Text>
        </Pressable>
      </View>

      <View style={styles.calendarStatsBar}>
        <Text style={styles.calendarStatsText}>
          {t('calendarStats', {
            count: monthDeadlines.length,
            expired: monthDeadlines.filter(item => statusFor(item, settings, t).id === 'expired').length,
            critical: monthDeadlines.filter(item => statusFor(item, settings, t).id === 'critical').length,
          })}
        </Text>
      </View>

      <View style={styles.calendarCard}>
        <View style={styles.calendarNav}>
          <Pressable style={styles.calendarNavButton} onPress={() => shiftMonth(-1)}>
            <Ionicons name="chevron-back" size={20} color="#0f172a" />
          </Pressable>
          <Text style={styles.calendarMonthLabel}>{monthLabel(viewYear, viewMonth, locale)}</Text>
          <Pressable style={styles.calendarNavButton} onPress={() => shiftMonth(1)}>
            <Ionicons name="chevron-forward" size={20} color="#0f172a" />
          </Pressable>
        </View>

        <View style={styles.calendarLegend}>
          <View style={styles.calendarLegendItem}>
            <View style={[styles.calendarLegendDot, {backgroundColor: C.red}]} />
            <Text style={styles.calendarLegendText}>{t('overdue')}</Text>
          </View>
          <View style={styles.calendarLegendItem}>
            <View style={[styles.calendarLegendDot, {backgroundColor: C.orange}]} />
            <Text style={styles.calendarLegendText}>{t('urgent')}</Text>
          </View>
          <View style={styles.calendarLegendItem}>
            <View style={[styles.calendarLegendDot, {backgroundColor: C.blue}]} />
            <Text style={styles.calendarLegendText}>{t('upcoming')}</Text>
          </View>
        </View>

        <View style={styles.calendarWeekdays}>
          {weekdayLabels.map(label => (
            <Text key={label} style={styles.calendarWeekday}>{label}</Text>
          ))}
        </View>

        <View style={styles.calendarGrid}>
          {grid.map((day, index) => {
            if (!day) {
              return <View key={`empty-${index}`} style={styles.calendarCell} />;
            }
            const dateKey = toDateKey(viewYear, viewMonth, day);
            const dayDeadlines = deadlinesByDate[dateKey] || [];
            const isSelected = selectedDate === dateKey;
            const isToday = dateKey === toDateKey(today.getFullYear(), today.getMonth(), today.getDate());
            const dominantStatus = dayDeadlines.length ? statusFor(dayDeadlines[0], settings, t) : null;

            return (
              <Pressable
                key={dateKey}
                style={[
                  styles.calendarCell,
                  dayDeadlines.length > 0 && styles.calendarCellHasEvent,
                  isSelected && styles.calendarCellSelected,
                  isToday && !isSelected && styles.calendarCellToday,
                  dominantStatus && dayDeadlines.length > 0 && !isSelected
                    ? {borderColor: dominantStatus.barColor + '55'}
                    : null,
                ]}
                onPress={() => setSelectedDate(dateKey)}>
                <Text style={[styles.calendarDayText, isSelected && styles.calendarDayTextSelected]}>
                  {day}
                </Text>
                {dayDeadlines.length === 1 ? (
                  <Text
                    style={[styles.calendarMiniTitle, isSelected && styles.calendarMiniTitleSelected]}
                    numberOfLines={1}>
                    {dayDeadlines[0].title}
                  </Text>
                ) : null}
                {dayDeadlines.length > 1 ? (
                  <View style={styles.calendarDots}>
                    {dayDeadlines.slice(0, 3).map(item => {
                      const status = statusFor(item, settings, t);
                      return <View key={item.id} style={[styles.calendarDot, {backgroundColor: status.barColor}]} />;
                    })}
                    <Text style={[styles.calendarCount, {color: dominantStatus.barColor}]}>
                      {dayDeadlines.length}
                    </Text>
                  </View>
                ) : dayDeadlines.length === 1 ? (
                  <View style={[styles.calendarSingleDot, {backgroundColor: dominantStatus.barColor}]} />
                ) : (
                  <View style={styles.calendarDots} />
                )}
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.calendarSectionTitle}>{t('selectedDay')}</Text>
      <Text style={styles.calendarSelectedLabel}>{formatDate(selectedDate, locale)}</Text>

      {selectedDeadlines.length ? (
        selectedDeadlines.map(item => (
          <CalendarDeadlineRow key={item.id} item={item} settings={settings} onPress={() => onPressDeadline(item)} />
        ))
      ) : (
        <View style={styles.calendarEmpty}>
          <Text style={styles.calendarEmptyText}>{t('noDeadlineThatDay')}</Text>
        </View>
      )}

      <Text style={styles.calendarSectionTitle}>{t('wholeMonth')}</Text>
      {monthDeadlines.length ? (
        monthDeadlines.map(item => (
          <CalendarDeadlineRow
            key={`month-${item.id}`}
            item={item}
            settings={settings}
            showDate
            onPress={() => {
              const date = parseDate(item.dueDate);
              if (date) {
                setViewYear(date.getFullYear());
                setViewMonth(date.getMonth());
                setSelectedDate(item.dueDate);
              }
              onPressDeadline(item);
            }}
          />
        ))
      ) : (
        <View style={styles.calendarEmpty}>
          <Text style={styles.calendarEmptyText}>{t('noDeadlineThisMonth')}</Text>
        </View>
      )}
    </ScrollView>
  );
}

function CalendarDeadlineRow({item, settings, onPress, showDate}) {
  const {t, locale} = useI18n();
  const status = statusFor(item, settings, t);
  return (
    <Pressable style={styles.calendarDeadlineRow} onPress={onPress}>
      <View style={[styles.calendarDeadlineDot, {backgroundColor: status.barColor}]} />
      <View style={styles.calendarDeadlineBody}>
        <Text style={styles.calendarDeadlineTitle}>{item.title}</Text>
        <Text style={styles.calendarDeadlineMeta}>
          {showDate ? `${formatDate(item.dueDate, locale)} · ` : ''}
          {item.domain ? `${item.domain} · ` : ''}{distanceLabel(item.dueDate, t)}
        </Text>
      </View>
      <View style={[styles.homeStatusBadge, {backgroundColor: status.barColor + '18'}]}>
        <Text style={[styles.homeStatusBadgeText, {color: status.barColor}]}>{status.label}</Text>
      </View>
    </Pressable>
  );
}

function HomeScreen({profile, stats, deadlines, settings, todayLabel, onPressDeadline, onAdd, onOpenCalendar}) {
  const {t} = useI18n();
  const attention = stats.critical + stats.expired;
  const summary = attention > 0
    ? t('homeSummaryAttention', {count: attention})
    : t('homeSummaryAllGood', {count: stats.upcoming});

  const sections = groupDeadlinesForHome(deadlines, settings, t).map(group => ({
    title: group.title,
    data: group.items,
  }));

  return (
    <SectionList
      style={styles.homeScreen}
      sections={sections}
      keyExtractor={item => item.id}
      contentContainerStyle={styles.homeContent}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={
        <View style={styles.homeHeader}>
          <View style={styles.homeHeaderLeft}>
            <Text style={styles.homeGreeting}>{t('hello', {name: profile.name})}</Text>
            <Text style={styles.homeToday}>{todayLabel}</Text>
            <Text style={styles.homeSummary}>{summary}</Text>
          </View>
          <Pressable style={styles.homeCalendarButton} onPress={onOpenCalendar}>
            <Ionicons name="calendar" size={18} color="#2563EB" />
            <Text style={styles.homeCalendarButtonText}>{t('calendar')}</Text>
          </Pressable>
        </View>
      }
      renderSectionHeader={({section}) => (
        <Text style={styles.homeSectionLabel}>{section.title}</Text>
      )}
      renderItem={({item}) => (
        <HomeDeadlineRow item={item} settings={settings} onPress={() => onPressDeadline(item)} />
      )}
      ListEmptyComponent={
        <View style={styles.homeEmpty}>
          <Text style={styles.homeEmptyTitle}>{t('noDeadlines')}</Text>
          <Text style={styles.homeEmptyCopy}>{t('addFirstDeadline')}</Text>
          <Pressable style={styles.homeEmptyButton} onPress={onAdd}>
            <Text style={styles.homeEmptyButtonText}>{t('addDeadline')}</Text>
          </Pressable>
        </View>
      }
    />
  );
}

function HomeDeadlineRow({item, settings, onPress}) {
  const {t} = useI18n();
  const status = statusFor(item, settings, t);
  const progress = urgencyProgress(item.dueDate, settings);
  const iconName = domainIconName(item.domain);

  return (
    <Pressable style={styles.homeRow} onPress={onPress}>
      <View style={styles.homeRowTop}>
        <View style={[styles.homeRowIconBox, {backgroundColor: status.barColor + '18'}]}>
          <Ionicons name={iconName} size={22} color={status.barColor} />
        </View>
        <View style={styles.homeRowBody}>
          <Text style={styles.homeRowTitle} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.homeRowMeta} numberOfLines={1}>
            {item.domain ? `${item.domain} · ` : ''}{distanceLabel(item.dueDate, t)}
          </Text>
        </View>
        <View style={[styles.homeStatusBadge, {backgroundColor: status.barColor + '18'}]}>
          <Text style={[styles.homeStatusBadgeText, {color: status.barColor}]}>{status.label}</Text>
        </View>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, {width: `${Math.round(progress * 100)}%`, backgroundColor: status.barColor}]} />
      </View>
      <View style={styles.progressFooter}>
        <Text style={styles.progressPct}>{Math.round(progress * 100)}%</Text>
        <Text style={styles.progressDate}>{distanceLabel(item.dueDate, t)}</Text>
      </View>
    </Pressable>
  );
}

function AddScreen({form, settings, updateForm, saveDeadline, onCancel}) {
  const {t} = useI18n();
  const isEditing = Boolean(form.id);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.formContent}>
      <Text style={styles.pageTitle}>{isEditing ? t('editDeadline') : t('newDeadline')}</Text>

      <Input
        label={t('title')}
        value={form.title}
        placeholder={t('titlePlaceholder')}
        onChangeText={value => updateForm('title', value)}
      />
      <DatePickerField
        label={t('dueDate')}
        value={form.dueDate}
        onChange={value => updateForm('dueDate', value)}
      />

      <Input
        label={t('note')}
        value={form.note}
        multiline
        placeholder={t('optional')}
        onChangeText={value => updateForm('note', value)}
      />

      <Text style={styles.fieldLabel}>{t('repeats')}</Text>
      <SegmentedControl
        value={form.repetition}
        options={[
          ['none', t('no')],
          ['monthly', t('monthly')],
          ['yearly', t('yearly')],
        ]}
        onChange={value => updateForm('repetition', value)}
      />

      <ReminderPlanner
        offsets={form.reminderOffsets}
        hour={form.reminderHour}
        minute={form.reminderMinute}
        onOffsetsChange={offsets => updateForm('reminderOffsets', offsets)}
        onTimeChange={(hour, minute) => updateForm({reminderHour: hour, reminderMinute: minute})}
      />

      <PrimaryButton
        label={isEditing ? t('saveChanges') : t('save')}
        onPress={saveDeadline}
      />
      {isEditing ? (
        <Pressable style={styles.secondaryFullButton} onPress={onCancel}>
          <Text style={styles.secondaryButtonText}>{t('cancel')}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function SettingsScreen({
  profile,
  settings,
  stats,
  deadlines,
  subscription,
  updateSettings,
  onSubscribe,
  onRefreshSubscription,
  onUpdateEmail,
}) {
  const {t, locale, language, setLanguage} = useI18n();
  const priceLabel = t('pricePerYear', {price: SUBSCRIPTION_ANNUAL_FCFA.toLocaleString(locale)});
  const used = deadlines.length;
  const limit = subscription.isTrialActive ? TRIAL_DEADLINE_LIMIT : 0;
  const needsEmail = isPlaceholderEmail(profile?.email);
  const [emailDraft, setEmailDraft] = useState(needsEmail ? '' : (profile?.email || ''));
  const [savingEmail, setSavingEmail] = useState(false);
  const ages = ageRangeOptions(t);

  useEffect(() => {
    setEmailDraft(isPlaceholderEmail(profile?.email) ? '' : (profile?.email || ''));
  }, [profile?.email]);

  async function saveEmail() {
    setSavingEmail(true);
    try {
      const ok = await onUpdateEmail?.(emailDraft);
      if (ok) {
        Alert.alert(t('profileSaved'), t('emailSaved'));
      }
    } finally {
      setSavingEmail(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.formContent}>
      <Text style={styles.pageTitle}>{t('settings')}</Text>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>{t('profile')}</Text>
        <Text style={styles.settingsValue}>{profile.name}</Text>
        {isValidEmail(profile?.email) ? (
          <Text style={styles.deadlineMeta}>{profile.email}</Text>
        ) : null}
        {profile.ageRange ? (
          <Text style={styles.deadlineMeta}>{labelForOption(ages, profile.ageRange)}</Text>
        ) : null}
        {needsEmail ? (
          <>
            <Input
              label={t('emailOptional')}
              value={emailDraft}
              placeholder={t('emailPlaceholder')}
              keyboardType="email-address"
              autoCapitalize="none"
              onChangeText={setEmailDraft}
            />
            <Pressable
              style={[styles.smallAction, savingEmail && styles.smallActionDisabled]}
              onPress={saveEmail}
              disabled={savingEmail}
            >
              <Text style={styles.smallActionText}>
                {savingEmail ? t('saving') : t('saveEmail')}
              </Text>
            </Pressable>
          </>
        ) : null}
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>{t('subscription')}</Text>
        {subscription.isActive ? (
          <>
            <Text style={styles.settingsValue}>{t('active')}</Text>
            <Text style={styles.deadlineMeta}>
              {t('daysLeft', {count: subscription.daysLeft})}
              {subscription.endsAt ? ` · ${t('until', {date: formatDate(subscription.endsAt.slice(0, 10), locale)})}` : ''}
            </Text>
            <Text style={styles.deadlineMeta}>{t('unlimitedDeadlines')}</Text>
          </>
        ) : subscription.isTrialActive ? (
          <>
            <Text style={styles.settingsValue}>{t('freeTrial')}</Text>
            <Text style={styles.deadlineMeta}>
              {t('daysLeft', {count: subscription.trialDaysLeft})}
              {subscription.trialEndsAt
                ? ` · ${t('until', {date: formatDate(subscription.trialEndsAt.slice(0, 10), locale)})}`
                : ''}
            </Text>
            <Text style={styles.deadlineMeta}>
              {t('trialUsage', {limit: TRIAL_DEADLINE_LIMIT, used})}
            </Text>
            <Text style={styles.deadlineMeta}>
              {t('thenSubscribe', {price: priceLabel})}
            </Text>
            <Pressable style={styles.smallAction} onPress={onSubscribe}>
              <Text style={styles.smallActionText}>{t('subscribeNow', {price: priceLabel})}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.settingsValue}>{t('trialEnded')}</Text>
            <Text style={styles.deadlineMeta}>
              {t('subscribeToAdd', {price: priceLabel})}
            </Text>
            <Text style={styles.deadlineMeta}>
              {t('deadlinesSaved', {count: used})}
              {limit === 0 ? ` · ${t('limitReached')}` : ''}
            </Text>
            <Pressable style={styles.smallAction} onPress={onSubscribe}>
              <Text style={styles.smallActionText}>{t('subscribe', {price: priceLabel})}</Text>
            </Pressable>
          </>
        )}
        <Pressable style={styles.subscriptionRefresh} onPress={onRefreshSubscription}>
          <Text style={styles.subscriptionRefreshText}>{t('refreshStatus')}</Text>
        </Pressable>
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>{t('notifications')}</Text>
        <ToggleRow
          label={t('localReminders')}
          value={settings.notificationsEnabled}
          onChange={value => updateSettings({notificationsEnabled: value})}
        />
        <ToggleRow
          label={t('strongAlerts')}
          value={settings.strongAlertsEnabled !== false}
          onChange={value => updateSettings({strongAlertsEnabled: value})}
        />

        <ReminderPlanner
          compact
          offsets={settings.defaultReminderOffsets}
          hour={settings.defaultReminderHour}
          minute={settings.defaultReminderMinute}
          onOffsetsChange={offsets => updateSettings({defaultReminderOffsets: offsets})}
          onTimeChange={(hour, minute) => updateSettings({defaultReminderHour: hour, defaultReminderMinute: minute})}
        />
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>{t('autoThresholds')}</Text>
        <Stepper
          label={t('critical')}
          value={settings.criticalDays}
          suffix={t('daysSuffix')}
          decrease={() => updateSettings({criticalDays: Math.max(1, settings.criticalDays - 1)})}
          increase={() => updateSettings({criticalDays: settings.criticalDays + 1})}
        />
        <Stepper
          label={t('watch')}
          value={settings.watchDays}
          suffix={t('daysSuffix')}
          decrease={() => updateSettings({watchDays: Math.max(settings.criticalDays + 1, settings.watchDays - 1)})}
          increase={() => updateSettings({watchDays: settings.watchDays + 1})}
        />
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>{t('localData')}</Text>
        <Text style={styles.settingsValue}>{deadlines.length}</Text>
        <Text style={styles.deadlineMeta}>{t('deadlinesOnPhone')}</Text>
        <Text style={styles.deadlineMeta}>
          {t('upcomingExpired', {upcoming: stats.upcoming, expired: stats.expired})}
        </Text>
      </View>

      <View style={styles.settingsCard}>
        <ToggleRow
          label={t('english')}
          value={language === 'en'}
          onChange={enabled => setLanguage(enabled ? 'en' : 'fr')}
        />
      </View>
    </ScrollView>
  );
}

function DeadlineModal({deadline, settings, close, onEdit, renewDeadline, deleteDeadline}) {
  const {t, locale} = useI18n();
  if (!deadline) {
    return null;
  }
  const status = statusFor(deadline, settings, t);
  const isRecurring = deadline.repetition !== 'none';
  const iconName = domainIconName(deadline.domain);

  function handleDone() {
    if (isRecurring) {
      renewDeadline(deadline);
    } else {
      deleteDeadline(deadline);
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalPanel}>
          <View style={styles.modalHandle} />

          <View style={styles.modalHeader}>
            <View style={[styles.modalIconBox, {backgroundColor: status.barColor + '18'}]}>
              <Ionicons name={iconName} size={26} color={status.barColor} />
            </View>
            <View style={styles.modalHeaderText}>
              <Text style={styles.modalTitle} numberOfLines={2}>{deadline.title}</Text>
              <View style={styles.modalStatusRow}>
                <View style={[styles.modalStatusPill, {backgroundColor: status.barColor + '18'}]}>
                  <Text style={[styles.modalStatusLabel, {color: status.barColor}]}>{status.label}</Text>
                </View>
                {deadline.domain ? (
                  <Text style={styles.modalDomain}>{deadline.domain}</Text>
                ) : null}
              </View>
            </View>
          </View>

          <View style={styles.modalDateRow}>
            <Ionicons name="calendar-outline" size={16} color="#94a3b8" />
            <Text style={styles.modalDate}>{formatDate(deadline.dueDate, locale)}</Text>
            <Text style={styles.modalDistance}>{distanceLabel(deadline.dueDate, t)}</Text>
          </View>

          {deadline.note ? (
            <View style={styles.modalNoteBox}>
              <Text style={styles.modalNote}>{deadline.note}</Text>
            </View>
          ) : null}

          <View style={styles.modalMeta}>
            <View style={styles.modalMetaItem}>
              <Ionicons name="repeat-outline" size={14} color="#94a3b8" />
              <Text style={styles.modalMetaText}>{repetitionLabel(deadline.repetition, t)}</Text>
            </View>
            <View style={styles.modalMetaItem}>
              <Ionicons name="notifications-outline" size={14} color="#94a3b8" />
              <Text style={styles.modalMetaText}>{remindersLabel(deadline, t)}</Text>
            </View>
          </View>

          <View style={styles.modalActions}>
            <Pressable style={styles.modalDoneButton} onPress={handleDone}>
              <Ionicons name="checkmark-circle-outline" size={20} color="#ffffff" />
              <Text style={styles.modalDoneText}>
                {isRecurring ? t('markDoneRenew') : t('markDoneArchive')}
              </Text>
            </Pressable>
            <Pressable style={styles.modalEditButton} onPress={() => onEdit(deadline)}>
              <Ionicons name="create-outline" size={18} color="#2563EB" />
              <Text style={styles.modalEditText}>{t('edit')}</Text>
            </Pressable>
            <View style={styles.modalSecondaryRow}>
              <Pressable style={styles.modalDeleteButton} onPress={() => deleteDeadline(deadline)}>
                <Ionicons name="trash-outline" size={18} color="#dc2626" />
                <Text style={styles.modalDeleteText}>{t('delete')}</Text>
              </Pressable>
              <Pressable style={styles.modalCloseButton} onPress={close}>
                <Text style={styles.modalCloseText}>{t('close')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function SubscriptionPaywallModal({visible, subscription, loading, onClose, onSubscribe}) {
  const {t, locale} = useI18n();
  const priceLabel = t('pricePerYear', {price: SUBSCRIPTION_ANNUAL_FCFA.toLocaleString(locale)});
  const title = subscription?.isTrialActive ? t('paywallTrialLimit') : t('paywallTrialEnded');
  const copy = subscription?.isTrialActive
    ? t('paywallTrialCopy', {limit: TRIAL_DEADLINE_LIMIT})
    : t('paywallEndedCopy');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.paywallBackdrop}>
        <View style={styles.paywallPanel}>
          <View style={styles.paywallIconBox}>
            <Ionicons name="lock-closed" size={28} color="#2563EB" />
          </View>
          <Text style={styles.paywallTitle}>{title}</Text>
          <Text style={styles.paywallCopy}>{copy}</Text>
          {subscription?.isTrialActive && subscription?.trialDaysLeft != null ? (
            <Text style={styles.paywallPriceHint}>
              {t('trialDaysLeft', {count: subscription.trialDaysLeft})}
            </Text>
          ) : null}
          <View style={styles.paywallPriceBox}>
            <Text style={styles.paywallPrice}>{priceLabel}</Text>
            <Text style={styles.paywallPriceHint}>{t('enterPhoneOnPayment')}</Text>
          </View>
          <PrimaryButton
            label={loading ? t('loadingDots') : t('subscribe', {price: priceLabel})}
            onPress={onSubscribe}
          />
          <Pressable style={styles.paywallClose} onPress={onClose}>
            <Text style={styles.paywallCloseText}>{t('later')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function SubscriptionPaymentModal({paymentUrl, onClose, onComplete}) {
  const {t} = useI18n();
  const [loading, setLoading] = useState(true);
  const handledRef = useRef(false);

  useEffect(() => {
    handledRef.current = false;
    setLoading(true);
  }, [paymentUrl]);

  if (!paymentUrl) {
    return null;
  }

  function finish(cancelled = false) {
    if (handledRef.current) {
      return;
    }
    handledRef.current = true;
    onComplete(cancelled);
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.paymentModal}>
        <View style={styles.paymentHeader}>
          <Pressable style={styles.paymentCloseBtn} onPress={() => finish(true)}>
            <Ionicons name="close" size={26} color="#0f172a" />
          </Pressable>
          <Text style={styles.paymentHeaderTitle}>{t('paymentHeader')}</Text>
          <View style={styles.paymentCloseBtn} />
        </View>
        <View style={styles.paymentWebviewWrap}>
          {loading ? (
            <View style={styles.paymentLoader}>
              <ActivityIndicator size="large" color={C.blue} />
            </View>
          ) : null}
          <WebView
            source={{uri: paymentUrl}}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            onNavigationStateChange={navState => {
              if (!isPaymentReturnUrl(navState.url)) {
                return;
              }
              finish(navState.url.toLowerCase().includes('cancelled'));
            }}
            onShouldStartLoadWithRequest={request => {
              if (isPaymentReturnUrl(request.url)) {
                finish(request.url.toLowerCase().includes('cancelled'));
                return false;
              }
              return true;
            }}
            javaScriptEnabled
            domStorageEnabled
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function TabButton({id, label, icon, activeTab, setActiveTab}) {
  const active = activeTab === id;
  return (
    <Pressable style={[styles.tabButton, active && styles.tabButtonActive]} onPress={() => setActiveTab(id)}>
      <Ionicons
        name={active ? icon : `${icon}-outline`}
        size={22}
        color={active ? '#2563EB' : '#94a3b8'}
      />
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function labelForOption(options, value) {
  return options.find(([id]) => id === value)?.[1] || value;
}

async function removeSampleDeadlines(database) {
  const samples = [
    ['Passeport', '2026-07-06'],
    ['Assurance voiture', '2026-07-10'],
    ['Loyer', '2026-07-24'],
    ['Controle technique', '2027-01-20'],
  ];

  for (const [title, dueDate] of samples) {
    const row = await database.getFirstAsync(
      'SELECT id FROM deadlines WHERE title = ? AND due_date = ?',
      title,
      dueDate,
    );
    if (row?.id) {
      await cancelDeadlineNotifications(String(row.id));
      await database.runAsync('DELETE FROM deadlines WHERE id = ?', row.id);
    }
  }
}

async function ensureAppSettingsColumns(database) {
  const columns = await database.getAllAsync('PRAGMA table_info(app_settings)');
  const names = new Set(columns.map(column => column.name));
  if (!names.has('intro_completed')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN intro_completed INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('notifications_enabled')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1`);
  }
  if (!names.has('default_reminder_hour')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN default_reminder_hour INTEGER NOT NULL DEFAULT 9`);
  }
  if (!names.has('default_reminder_minute')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN default_reminder_minute INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('default_reminder_offsets')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN default_reminder_offsets TEXT NOT NULL DEFAULT '[0,1,7]'`);
  }
  if (!names.has('device_id')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN device_id TEXT`);
  }
  if (!names.has('subscription_active')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN subscription_active INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('subscription_ends_at')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN subscription_ends_at TEXT`);
  }
    if (!names.has('trial_started_at')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN trial_started_at TEXT`);
  }
  if (!names.has('language')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN language TEXT NOT NULL DEFAULT 'fr'`);
  }
  if (!names.has('strong_alerts')) {
    await database.execAsync(`ALTER TABLE app_settings ADD COLUMN strong_alerts INTEGER NOT NULL DEFAULT 1`);
  }
}

async function ensureDeadlineColumns(database) {
  const columns = await database.getAllAsync('PRAGMA table_info(deadlines)');
  const names = new Set(columns.map(column => column.name));
  if (!names.has('reminder_offsets')) {
    await database.execAsync(`ALTER TABLE deadlines ADD COLUMN reminder_offsets TEXT`);
  }
  if (!names.has('reminder_hour')) {
    await database.execAsync(`ALTER TABLE deadlines ADD COLUMN reminder_hour INTEGER NOT NULL DEFAULT 9`);
  }
  if (!names.has('reminder_minute')) {
    await database.execAsync(`ALTER TABLE deadlines ADD COLUMN reminder_minute INTEGER NOT NULL DEFAULT 0`);
  }

  const rows = await database.getAllAsync('SELECT * FROM deadlines WHERE reminder_offsets IS NULL OR reminder_offsets = ""');
  for (const row of rows) {
    const offsets = parseReminderOffsets(null, row);
    await database.runAsync(
      'UPDATE deadlines SET reminder_offsets = ?, reminder_hour = COALESCE(reminder_hour, 9), reminder_minute = COALESCE(reminder_minute, 0) WHERE id = ?',
      JSON.stringify(offsets),
      row.id,
    );
  }
}

async function ensureProfileColumns(database) {
  const columns = await database.getAllAsync('PRAGMA table_info(profile)');
  const names = new Set(columns.map(column => column.name));
  if (!names.has('usage_reason')) {
    await database.execAsync(`ALTER TABLE profile ADD COLUMN usage_reason TEXT NOT NULL DEFAULT ''`);
  }
  if (!names.has('age_range')) {
    await database.execAsync(`ALTER TABLE profile ADD COLUMN age_range TEXT NOT NULL DEFAULT ''`);
  }
  if (!names.has('terms_accepted')) {
    await database.execAsync(`ALTER TABLE profile ADD COLUMN terms_accepted INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('email')) {
    await database.execAsync(`ALTER TABLE profile ADD COLUMN email TEXT NOT NULL DEFAULT ''`);
  }
  if (!names.has('phone')) {
    await database.execAsync(`ALTER TABLE profile ADD COLUMN phone TEXT NOT NULL DEFAULT ''`);
  }
}

function Dropdown({label, value, options, placeholder, onChange}) {
  const [open, setOpen] = useState(false);
  const selectedLabel = value ? labelForOption(options, value) : '';

  return (
    <View style={styles.inputGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pressable style={styles.dropdown} onPress={() => setOpen(true)}>
        <Text style={[styles.dropdownText, !selectedLabel && styles.dropdownPlaceholder]}>
          {selectedLabel || placeholder}
        </Text>
        <Text style={styles.dropdownChevron}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.dropdownBackdrop} onPress={() => setOpen(false)}>
          <View style={styles.dropdownSheet}>
            <Text style={styles.dropdownSheetTitle}>{label}</Text>
            {options.map(([id, optionLabel]) => {
              const active = value === id;
              return (
                <Pressable
                  key={id}
                  style={[styles.dropdownOption, active && styles.dropdownOptionActive]}
                  onPress={() => {
                    onChange(id);
                    setOpen(false);
                  }}>
                  <Text style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive]}>
                    {optionLabel}
                  </Text>
                  {active ? <Text style={styles.dropdownOptionCheck}>✓</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function TermsRow({accepted, onToggle}) {
  const {t} = useI18n();
  return (
    <Pressable style={styles.termsRow} onPress={onToggle}>
      <View style={[styles.termsCheckbox, accepted && styles.termsCheckboxActive]}>
        {accepted ? <Text style={styles.termsCheckmark}>✓</Text> : null}
      </View>
      <Text style={styles.termsText}>{t('acceptTerms')}</Text>
    </Pressable>
  );
}

function Input({label, value, onChangeText, placeholder, multiline, keyboardType, autoCapitalize}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.textArea]}
        value={value}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        multiline={multiline}
        keyboardType={keyboardType || 'default'}
        autoCapitalize={autoCapitalize || (multiline ? 'sentences' : 'sentences')}
        autoCorrect={false}
        onChangeText={onChangeText}
      />
    </View>
  );
}

function DatePickerField({label, value, onChange}) {
  const {t, locale} = useI18n();
  const [show, setShow] = useState(false);
  const [draftDate, setDraftDate] = useState(() => parseDate(value) || new Date());

  useEffect(() => {
    if (show) {
      setDraftDate(parseDate(value) || new Date());
    }
  }, [show, value]);

  function applyDate(date) {
    onChange(toDateKey(date.getFullYear(), date.getMonth(), date.getDate()));
  }

  return (
    <View style={styles.inputGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pressable style={styles.datePickerButton} onPress={() => setShow(true)}>
        <Text style={[styles.datePickerText, !value && styles.datePickerPlaceholder]}>
          {value ? formatDate(value, locale) : t('chooseDate')}
        </Text>
        <Ionicons name="calendar-outline" size={20} color="#64748b" />
      </Pressable>

      {Platform.OS === 'ios' ? (
        <Modal visible={show} transparent animationType="fade" onRequestClose={() => setShow(false)}>
          <Pressable style={styles.datePickerBackdrop} onPress={() => setShow(false)}>
            <Pressable style={styles.datePickerSheet} onPress={event => event.stopPropagation()}>
              <View style={styles.datePickerToolbar}>
                <Pressable onPress={() => setShow(false)}>
                  <Text style={styles.datePickerCancel}>{t('cancel')}</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    applyDate(draftDate);
                    setShow(false);
                  }}>
                  <Text style={styles.datePickerDone}>OK</Text>
                </Pressable>
              </View>
              <DateTimePicker
                value={draftDate}
                mode="date"
                display="spinner"
                locale={locale}
                onChange={(event, date) => {
                  if (date) {
                    setDraftDate(date);
                  }
                }}
              />
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}

      {Platform.OS === 'android' && show ? (
        <DateTimePicker
          value={parseDate(value) || new Date()}
          mode="date"
          display="default"
          locale={locale}
          onChange={(event, date) => {
            setShow(false);
            if (event.type !== 'dismissed' && date) {
              applyDate(date);
            }
          }}
        />
      ) : null}
    </View>
  );
}

function SegmentedControl({value, options, onChange}) {
  return (
    <View style={styles.segmented}>
      {options.map(([id, label]) => (
        <Pressable key={id} style={[styles.segment, value === id && styles.segmentActive]} onPress={() => onChange(id)}>
          <Text style={[styles.segmentText, value === id && styles.segmentTextActive]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ReminderPlanner({offsets, hour, minute, onOffsetsChange, onTimeChange, compact}) {
  const {t} = useI18n();
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [newCustomDays, setNewCustomDays] = useState(2);
  const customOffsets = getCustomOffsets(offsets || []);

  function toggleOffset(days) {
    const current = offsets || [];
    const next = current.includes(days)
      ? current.filter(value => value !== days)
      : [...current, days].sort((a, b) => a - b);
    onOffsetsChange(next);
  }

  function addCustomOffset() {
    if (newCustomDays < 0 || newCustomDays > 365) {
      return;
    }
    if (!(offsets || []).includes(newCustomDays)) {
      onOffsetsChange([...(offsets || []), newCustomDays].sort((a, b) => a - b));
    }
    setShowAddCustom(false);
    setNewCustomDays(2);
  }

  function removeOffset(days) {
    onOffsetsChange((offsets || []).filter(value => value !== days));
  }

  return (
    <View style={[styles.reminderPlanner, compact && styles.reminderPlannerCompact]}>
      {!compact ? (
        <View style={styles.reminderPlannerHeader}>
          <View style={styles.reminderPlannerIcon}>
            <Ionicons name="notifications-outline" size={18} color={C.blue} />
          </View>
          <View>
            <Text style={styles.reminderPlannerTitle}>{t('reminders')}</Text>
            <Text style={styles.reminderPlannerHint}>{t('reminderHint')}</Text>
          </View>
        </View>
      ) : (
        <Text style={styles.settingsSubtitle}>{t('defaultPreferences')}</Text>
      )}

      <Text style={styles.reminderSectionLabel}>{t('atWhatTime')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.timePillsRow}>
        {TIME_OPTIONS.map(option => {
          const active = isSameTime(option, hour, minute);
          return (
            <Pressable
              key={option.label}
              style={[styles.timePill, active && styles.timePillActive]}
              onPress={() => onTimeChange(option.hour, option.minute)}>
              <Text style={[styles.timePillText, active && styles.timePillTextActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <Text style={styles.reminderSectionLabel}>{t('notifyMe')}</Text>
      <View style={styles.reminderToggleList}>
        {REMINDER_PRESETS.map((preset, index) => (
          <View
            key={preset.days}
            style={[
              styles.reminderToggleRow,
              index === REMINDER_PRESETS.length - 1 && customOffsets.length === 0 && styles.reminderToggleRowLast,
            ]}>
            <Text style={styles.reminderToggleLabel}>{t(preset.labelKey)}</Text>
            <Switch
              value={(offsets || []).includes(preset.days)}
              onValueChange={() => toggleOffset(preset.days)}
              trackColor={{false: '#e2e8f0', true: '#93c5fd'}}
              thumbColor={(offsets || []).includes(preset.days) ? '#2563EB' : '#f8fafc'}
            />
          </View>
        ))}

        {customOffsets.map((days, index) => (
          <View
            key={`custom-${days}`}
            style={[styles.reminderToggleRow, index === customOffsets.length - 1 && styles.reminderToggleRowLast]}>
            <Text style={styles.reminderToggleLabel}>{offsetLabel(days, t)}</Text>
            <Pressable style={styles.reminderRemoveButton} onPress={() => removeOffset(days)}>
              <Ionicons name="close-circle" size={22} color="#94a3b8" />
            </Pressable>
          </View>
        ))}
      </View>

      {showAddCustom ? (
        <View style={styles.reminderAddBox}>
          <Stepper
            label={t('daysBeforeDue')}
            value={newCustomDays}
            suffix="j"
            decrease={() => setNewCustomDays(current => Math.max(0, current - 1))}
            increase={() => setNewCustomDays(current => Math.min(365, current + 1))}
          />
          <View style={styles.reminderAddActions}>
            <Pressable style={styles.reminderAddCancel} onPress={() => setShowAddCustom(false)}>
              <Text style={styles.reminderAddCancelText}>{t('cancel')}</Text>
            </Pressable>
            <Pressable style={styles.reminderAddConfirm} onPress={addCustomOffset}>
              <Text style={styles.reminderAddConfirmText}>{t('add')}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable style={styles.reminderAddButton} onPress={() => setShowAddCustom(true)}>
          <Ionicons name="add-circle-outline" size={18} color="#2563EB" />
          <Text style={styles.reminderAddButtonText}>{t('addCustomReminder')}</Text>
        </Pressable>
      )}
    </View>
  );
}

function ToggleRow({label, value, onChange}) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function Stepper({label, value, suffix, decrease, increase}) {
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <Pressable style={styles.stepButton} onPress={decrease}>
          <Text style={styles.stepButtonText}>-</Text>
        </Pressable>
        <Text style={styles.stepValue}>{value} {suffix}</Text>
        <Pressable style={styles.stepButton} onPress={increase}>
          <Text style={styles.stepButtonText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function PrimaryButton({label, onPress}) {
  return (
    <Pressable style={styles.primaryButton} onPress={onPress}>
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#FFFFFF'},
  loadingScreen: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F8FAFC'},
  loadingBrand: {flexDirection: 'row', alignItems: 'center', gap: 12},
  loadingLogo: {width: 48, height: 48, borderRadius: 10},
  loadingBrandName: {color: '#2563EB', fontSize: 28, fontWeight: '800', letterSpacing: -0.5},
  loadingText: {color: '#64748b', marginTop: 12, fontSize: 15, fontWeight: '600'},
  onboardingScreen: {flex: 1, backgroundColor: '#F8FAFC'},
  onboardingTopBar: {alignItems: 'flex-end', paddingHorizontal: 20, paddingTop: 8},
  onboardingSkip: {color: '#64748b', fontSize: 14, fontWeight: '700'},
  onboardingBody: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28},
  onboardingIllustration: {width: 280, height: 280, marginBottom: 28, resizeMode: 'contain'},
  onboardingLogo: {width: 140, height: 140, borderRadius: 34, marginBottom: 28},
  onboardingTitle: {color: '#0f172a', fontSize: 30, fontWeight: '900', textAlign: 'center', marginBottom: 12},
  onboardingCopy: {color: '#64748b', fontSize: 16, lineHeight: 24, textAlign: 'center'},
  onboardingFooter: {paddingHorizontal: 20, paddingBottom: 24},
  onboardingDots: {flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 18},
  onboardingDot: {width: 8, height: 8, borderRadius: 999, backgroundColor: '#cbd5e1'},
  onboardingDotActive: {width: 24, backgroundColor: '#2563EB'},
  accessScreen: {flex: 1, backgroundColor: '#F8FAFC'},
  accessScroll: {flexGrow: 1, justifyContent: 'center', padding: 20},
  accessPanel: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 22,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  accessLogo: {width: 106, height: 106, borderRadius: 10, alignSelf: 'center', marginBottom: 16},
  accessTitle: {color: '#0f172a', fontSize: 26, fontWeight: '900', textAlign: 'center'},
  accessCopy: {color: '#64748b', fontSize: 14, lineHeight: 20, marginTop: 8, marginBottom: 18, textAlign: 'center'},
  accessHint: {color: '#64748b', fontSize: 12, marginTop: -8, marginBottom: 14, lineHeight: 16},
  trialBanner: {
    backgroundColor: '#EFF6FF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  trialBannerTitle: {color: '#1D4ED8', fontSize: 15, fontWeight: '800', marginBottom: 4},
  trialBannerCopy: {color: '#334155', fontSize: 13, lineHeight: 19},
  dropdown: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 14,
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownText: {color: '#0f172a', fontSize: 15, fontWeight: '600', flex: 1},
  dropdownPlaceholder: {color: '#94a3b8', fontWeight: '500'},
  dropdownChevron: {color: '#64748b', fontSize: 16, marginLeft: 8},
  dropdownBackdrop: {flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)', justifyContent: 'flex-end'},
  dropdownSheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
  },
  dropdownSheetTitle: {color: '#0f172a', fontSize: 18, fontWeight: '900', marginBottom: 12},
  dropdownOption: {
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    backgroundColor: '#f8fafc',
  },
  dropdownOptionActive: {backgroundColor: '#ecfeff'},
  dropdownOptionText: {color: '#334155', fontSize: 15, fontWeight: '600'},
  dropdownOptionTextActive: {color: '#0f766e', fontWeight: '800'},
  dropdownOptionCheck: {color: '#0f766e', fontSize: 16, fontWeight: '900'},
  termsRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 4, marginBottom: 16},
  termsCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: '#94a3b8',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  termsCheckboxActive: {borderColor: '#0f766e', backgroundColor: '#0f766e'},
  termsCheckmark: {color: '#ffffff', fontSize: 13, fontWeight: '900', lineHeight: 14},
  termsText: {flex: 1, color: '#475569', fontSize: 13, lineHeight: 19, fontWeight: '600'},
  appShell: {flex: 1, backgroundColor: '#F8FAFC'},
  content: {flex: 1},

  // App header
  appHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  appHeaderBrand: {flexDirection: 'row', alignItems: 'center', gap: 10},
  appHeaderLogo: {width: 36, height: 36, borderRadius: 10},
  appHeaderName: {color: '#2563EB', fontSize: 20, fontWeight: '800', letterSpacing: -0.5},
  appHeaderAction: {width: 38, height: 38, alignItems: 'center', justifyContent: 'center'},

  // Home
  homeScreen: {flex: 1, backgroundColor: '#F8FAFC'},
  homeContent: {paddingHorizontal: 20, paddingTop: 20, paddingBottom: 100},
  homeHeader: {marginBottom: 24, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12},
  homeHeaderLeft: {flex: 1},
  homeCalendarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#eff6ff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  homeCalendarButtonText: {color: '#2563EB', fontSize: 13, fontWeight: '700'},
  homeGreeting: {color: '#0f172a', fontSize: 26, fontWeight: '800', lineHeight: 32},
  homeToday: {color: '#94a3b8', fontSize: 13, fontWeight: '500', marginTop: 4, marginBottom: 12, textTransform: 'capitalize'},
  homeSummary: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: '#2563EB',
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    overflow: 'hidden',
  },
  homeSectionLabel: {
    color: '#64748b',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
    marginTop: 4,
  },
  homeRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#2563EB',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 3},
    elevation: 2,
  },
  homeRowTop: {flexDirection: 'row', alignItems: 'center', marginBottom: 12},
  homeRowIconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  homeRowBody: {flex: 1},
  homeRowTitle: {color: '#0f172a', fontSize: 16, fontWeight: '700', lineHeight: 20},
  homeRowMeta: {color: '#94a3b8', fontSize: 13, marginTop: 3, fontWeight: '500'},
  homeStatusBadge: {borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4},
  homeStatusBadgeText: {fontSize: 12, fontWeight: '800'},
  progressTrack: {
    height: 6,
    backgroundColor: '#f1f5f9',
    borderRadius: 999,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressFill: {height: '100%', borderRadius: 999},
  progressFooter: {flexDirection: 'row', justifyContent: 'space-between'},
  progressPct: {color: '#64748b', fontSize: 12, fontWeight: '700'},
  progressDate: {color: '#94a3b8', fontSize: 12, fontWeight: '500'},
  homeStatusDot: {width: 12, height: 12, borderRadius: 999, marginLeft: 8},
  homeEmpty: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 36,
    alignItems: 'center',
    marginTop: 16,
    shadowColor: '#0f172a',
    shadowOpacity: 0.04,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 3},
    elevation: 1,
  },
  homeEmptyTitle: {color: '#0f172a', fontSize: 20, fontWeight: '700', marginTop: 4},
  homeEmptyCopy: {color: '#94a3b8', fontSize: 15, marginTop: 8, textAlign: 'center', lineHeight: 22},
  homeEmptyButton: {
    marginTop: 24,
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  homeEmptyButtonText: {color: '#ffffff', fontSize: 15, fontWeight: '700'},
  homeAddButton: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeAddButtonText: {color: '#ffffff', fontSize: 28, lineHeight: 30, fontWeight: '400'},

  // Shared
  screen: {flex: 1, paddingHorizontal: 20, backgroundColor: '#F8FAFC'},
  pageTitle: {color: '#0f172a', fontSize: 28, fontWeight: '800', marginBottom: 22, marginTop: 10, lineHeight: 34},
  sectionTitle: {color: '#0f172a', fontSize: 18, fontWeight: '700', marginBottom: 14},
  listContent: {paddingBottom: 32},
  deadlineTitle: {color: '#0f172a', fontSize: 17, fontWeight: '700', flex: 1},
  deadlineDate: {color: '#334155', fontSize: 14, fontWeight: '600', marginTop: 8},
  deadlineMeta: {color: '#94a3b8', fontSize: 14, marginTop: 4, fontWeight: '500'},

  // Forms
  formContent: {paddingBottom: 36},
  inputGroup: {marginBottom: 18},
  fieldLabel: {color: '#64748b', fontSize: 12, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8},
  input: {
    minHeight: 54,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '500',
  },
  textArea: {minHeight: 100, paddingTop: 14, textAlignVertical: 'top'},
  datePickerButton: {
    minHeight: 54,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  datePickerText: {color: '#0f172a', fontSize: 16, fontWeight: '600', flex: 1},
  datePickerPlaceholder: {color: '#94a3b8', fontWeight: '500'},
  datePickerBackdrop: {flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)', justifyContent: 'flex-end'},
  datePickerSheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 24,
  },
  datePickerToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  datePickerCancel: {color: '#64748b', fontSize: 16, fontWeight: '600'},
  datePickerDone: {color: '#2563EB', fontSize: 16, fontWeight: '800'},
  suggestionBlock: {marginBottom: 16},
  microLabel: {color: '#94a3b8', fontSize: 12, fontWeight: '800', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.8},
  chipGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {borderRadius: 999, backgroundColor: '#eff6ff', paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#bfdbfe'},
  chipMuted: {borderRadius: 999, backgroundColor: '#f1f5f9', paddingHorizontal: 14, paddingVertical: 8},
  chipText: {color: '#2563EB', fontSize: 13, fontWeight: '700'},
  segmented: {flexDirection: 'row', backgroundColor: '#e8eef4', borderRadius: 12, padding: 4, marginBottom: 16},
  segment: {flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center'},
  segmentActive: {backgroundColor: '#FFFFFF', shadowColor: '#0f172a', shadowOpacity: 0.08, shadowRadius: 4, shadowOffset: {width: 0, height: 1}, elevation: 2},
  segmentText: {color: '#94a3b8', fontSize: 13, fontWeight: '700', textAlign: 'center'},
  segmentTextActive: {color: '#0f172a'},
  toggleRow: {
    minHeight: 58,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: {color: '#0f172a', fontSize: 16, fontWeight: '600'},
  primaryButton: {
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginTop: 20,
    shadowColor: '#2563EB',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 4,
  },
  primaryButtonText: {color: '#ffffff', fontSize: 16, fontWeight: '700'},

  // Settings
  monthBlock: {marginBottom: 18},
  monthTitle: {color: '#94a3b8', fontSize: 13, fontWeight: '800', textTransform: 'capitalize', marginBottom: 10},
  softCard: {backgroundColor: '#FFFFFF', borderRadius: 14, padding: 18, marginBottom: 12, shadowColor: '#0f172a', shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: {width: 0, height: 2}, elevation: 1},
  emptyText: {color: '#94a3b8', fontSize: 15, backgroundColor: '#FFFFFF', borderRadius: 14, padding: 20, fontWeight: '500', textAlign: 'center'},
  settingsCard: {backgroundColor: '#FFFFFF', borderRadius: 14, padding: 20, marginBottom: 14, shadowColor: '#0f172a', shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: {width: 0, height: 2}, elevation: 1},
  settingsTitle: {color: '#0f172a', fontSize: 16, fontWeight: '700'},
  settingsSubtitle: {color: '#64748b', fontSize: 12, fontWeight: '700', marginTop: 16, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.8},
  settingsValue: {color: '#2563EB', fontSize: 34, fontWeight: '800', marginTop: 8},
  smallAction: {alignSelf: 'flex-start', marginTop: 14, backgroundColor: '#eff6ff', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10},
  smallActionDisabled: {opacity: 0.6},
  settingsWarning: {color: '#b45309', fontSize: 13, marginTop: 8, marginBottom: 4, fontWeight: '600', lineHeight: 18},
  smallActionText: {color: '#2563EB', fontSize: 14, fontWeight: '700'},
  subscriptionRefresh: {marginTop: 12, alignSelf: 'flex-start'},
  subscriptionRefreshText: {color: '#64748b', fontSize: 13, fontWeight: '600'},
  paywallBackdrop: {flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.5)', justifyContent: 'center', padding: 24},
  paywallPanel: {backgroundColor: '#ffffff', borderRadius: 20, padding: 24},
  paywallIconBox: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 16,
  },
  paywallTitle: {color: '#0f172a', fontSize: 24, fontWeight: '900', textAlign: 'center', marginBottom: 10},
  paywallCopy: {color: '#64748b', fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 18},
  paywallPriceBox: {backgroundColor: '#f8fafc', borderRadius: 12, padding: 16, marginBottom: 8, alignItems: 'center'},
  paywallPrice: {color: '#2563EB', fontSize: 28, fontWeight: '900'},
  paywallPriceHint: {color: '#94a3b8', fontSize: 12, marginTop: 6, textAlign: 'center'},
  paywallPhoneField: {marginBottom: 4, width: '100%'},
  paywallPhoneHint: {color: '#94a3b8', fontSize: 12, marginTop: -8, marginBottom: 8},
  paywallClose: {marginTop: 14, alignItems: 'center', paddingVertical: 10},
  paywallCloseText: {color: '#64748b', fontSize: 15, fontWeight: '600'},
  paymentModal: {flex: 1, backgroundColor: '#ffffff'},
  paymentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  paymentCloseBtn: {width: 40, height: 40, alignItems: 'center', justifyContent: 'center'},
  paymentHeaderTitle: {color: '#0f172a', fontSize: 17, fontWeight: '700'},
  paymentWebviewWrap: {flex: 1},
  paymentLoader: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    zIndex: 1,
  },
  toggleRowPlain: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14},
  stepperRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16},
  stepperControls: {flexDirection: 'row', alignItems: 'center', gap: 10},
  stepButton: {width: 38, height: 38, borderRadius: 10, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center'},
  stepButtonText: {color: '#0f172a', fontSize: 20, fontWeight: '700'},
  stepValue: {color: '#0f172a', fontSize: 16, fontWeight: '700', minWidth: 70, textAlign: 'center'},

  // Tab bar + FAB
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    shadowColor: '#0f172a',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: {width: 0, height: -3},
    elevation: 10,
  },
  tabButton: {flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 3},
  tabButtonActive: {backgroundColor: '#eff6ff'},
  tabText: {color: '#94a3b8', fontSize: 11, fontWeight: '600'},
  tabTextActive: {color: '#2563EB', fontWeight: '700'},
  fabWrapper: {flex: 1, alignItems: 'center'},
  fab: {
    backgroundColor: '#f97316',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
    shadowColor: '#f97316',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 6,
    marginTop: -28,
  },
  fabLabel: {color: '#ffffff', fontSize: 10, fontWeight: '800', textAlign: 'center', lineHeight: 13, marginTop: 2},

  // Calendar
  calendarContent: {paddingBottom: 100},
  calendarHeaderRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10},
  calendarTodayButton: {
    backgroundColor: '#eff6ff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  calendarTodayButtonText: {color: '#2563EB', fontSize: 13, fontWeight: '700'},
  calendarStatsBar: {
    backgroundColor: '#2563EB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 14,
    alignSelf: 'flex-start',
  },
  calendarStatsText: {color: '#ffffff', fontSize: 13, fontWeight: '700'},
  calendarCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 18,
    shadowColor: '#0f172a',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: {width: 0, height: 2},
    elevation: 1,
  },
  calendarNav: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16},
  calendarNavButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarMonthLabel: {color: '#0f172a', fontSize: 18, fontWeight: '800', textTransform: 'capitalize'},
  calendarLegend: {flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 12},
  calendarLegendItem: {flexDirection: 'row', alignItems: 'center', gap: 6},
  calendarLegendDot: {width: 8, height: 8, borderRadius: 999},
  calendarLegendText: {color: '#64748b', fontSize: 11, fontWeight: '600'},
  calendarWeekdays: {flexDirection: 'row', marginBottom: 8},
  calendarWeekday: {flex: 1, textAlign: 'center', color: '#94a3b8', fontSize: 12, fontWeight: '700'},
  calendarGrid: {flexDirection: 'row', flexWrap: 'wrap'},
  calendarCell: {
    width: '14.28%',
    minHeight: 62,
    alignItems: 'center',
    justifyContent: 'flex-start',
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 2,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  calendarCellHasEvent: {backgroundColor: '#f8fafc'},
  calendarCellSelected: {backgroundColor: '#2563EB'},
  calendarCellToday: {backgroundColor: '#eff6ff'},
  calendarDayText: {color: '#0f172a', fontSize: 14, fontWeight: '700'},
  calendarDayTextSelected: {color: '#ffffff'},
  calendarMiniTitle: {color: '#64748b', fontSize: 8, fontWeight: '700', marginTop: 2, maxWidth: '100%', textAlign: 'center'},
  calendarMiniTitleSelected: {color: '#dbeafe'},
  calendarDots: {flexDirection: 'row', gap: 3, minHeight: 6, marginTop: 4, alignItems: 'center'},
  calendarDot: {width: 5, height: 5, borderRadius: 999},
  calendarSingleDot: {width: 6, height: 6, borderRadius: 999, marginTop: 4},
  calendarCount: {fontSize: 9, fontWeight: '800', marginLeft: 2},
  calendarSectionTitle: {color: '#0f172a', fontSize: 16, fontWeight: '800', marginTop: 8, marginBottom: 8},
  calendarSelectedLabel: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 12,
    textTransform: 'capitalize',
  },
  calendarDeadlineRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  calendarDeadlineDot: {width: 10, height: 10, borderRadius: 999},
  calendarDeadlineBody: {flex: 1},
  calendarDeadlineTitle: {color: '#0f172a', fontSize: 15, fontWeight: '700'},
  calendarDeadlineMeta: {color: '#94a3b8', fontSize: 13, marginTop: 2},
  calendarEmpty: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
  },
  calendarEmptyText: {color: '#94a3b8', fontSize: 14, fontWeight: '500'},
  reminderPlanner: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: {width: 0, height: 2},
    elevation: 1,
  },
  reminderPlannerCompact: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    padding: 0,
    marginTop: 12,
    marginBottom: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  reminderPlannerHeader: {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18},
  reminderPlannerIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reminderPlannerTitle: {color: '#0f172a', fontSize: 17, fontWeight: '800'},
  reminderPlannerHint: {color: '#94a3b8', fontSize: 13, fontWeight: '500', marginTop: 2},
  reminderSectionLabel: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  timePillsRow: {flexDirection: 'row', gap: 8, paddingBottom: 4, marginBottom: 18},
  timePill: {
    borderRadius: 999,
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
  },
  timePillActive: {backgroundColor: '#eff6ff', borderColor: '#2563EB'},
  timePillText: {color: '#64748b', fontSize: 14, fontWeight: '700'},
  timePillTextActive: {color: '#2563EB'},
  reminderToggleList: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
    overflow: 'hidden',
  },
  reminderToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  reminderToggleRowLast: {borderBottomWidth: 0},
  reminderToggleLabel: {color: '#0f172a', fontSize: 15, fontWeight: '600'},
  reminderRemoveButton: {padding: 4},
  reminderAddButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  reminderAddButtonText: {color: '#2563EB', fontSize: 14, fontWeight: '700'},
  reminderAddBox: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  reminderAddActions: {flexDirection: 'row', gap: 10, marginTop: 14},
  reminderAddCancel: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reminderAddCancelText: {color: '#64748b', fontSize: 14, fontWeight: '700'},
  reminderAddConfirm: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reminderAddConfirmText: {color: '#ffffff', fontSize: 14, fontWeight: '700'},

  // Modal
  modalBackdrop: {flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.5)', justifyContent: 'flex-end'},
  modalPanel: {backgroundColor: '#FFFFFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 32},
  modalHandle: {width: 44, height: 5, borderRadius: 999, backgroundColor: '#e2e8f0', alignSelf: 'center', marginBottom: 20},
  modalHeader: {flexDirection: 'row', alignItems: 'flex-start', gap: 14, marginBottom: 16},
  modalIconBox: {width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  modalHeaderText: {flex: 1},
  modalTitle: {color: '#0f172a', fontSize: 20, fontWeight: '800', lineHeight: 26},
  modalStatusRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6},
  modalStatusPill: {borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3},
  modalStatusLabel: {fontSize: 12, fontWeight: '800'},
  modalDomain: {color: '#94a3b8', fontSize: 13, fontWeight: '500'},
  modalDateRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12},
  modalDate: {color: '#0f172a', fontSize: 15, fontWeight: '600'},
  modalDistance: {color: '#94a3b8', fontSize: 14, fontWeight: '500', marginLeft: 4},
  modalNoteBox: {backgroundColor: '#f8fafc', borderRadius: 10, padding: 12, marginBottom: 12},
  modalNote: {color: '#64748b', fontSize: 14, lineHeight: 20},
  modalMeta: {flexDirection: 'row', gap: 16, marginBottom: 20},
  modalMetaItem: {flexDirection: 'row', alignItems: 'center', gap: 5},
  modalMetaText: {color: '#94a3b8', fontSize: 13, fontWeight: '500'},
  modalStatus: {fontSize: 15, fontWeight: '700', marginTop: 8},
  modalActions: {gap: 10},
  modalDoneButton: {
    minHeight: 54,
    borderRadius: 14,
    backgroundColor: '#2563EB',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#2563EB',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: {width: 0, height: 3},
    elevation: 4,
  },
  modalDoneText: {color: '#ffffff', fontSize: 15, fontWeight: '700'},
  modalEditButton: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  modalEditText: {color: '#2563EB', fontSize: 14, fontWeight: '700'},
  modalSecondaryRow: {flexDirection: 'row', gap: 10},
  modalDeleteButton: {flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: '#fff1f0', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6},
  modalDeleteText: {color: '#dc2626', fontSize: 14, fontWeight: '700'},
  modalCloseButton: {flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center'},
  modalCloseText: {color: '#64748b', fontSize: 14, fontWeight: '600'},
  secondaryFullButton: {minHeight: 52, borderRadius: 12, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, marginTop: 10},
  secondaryButtonText: {color: '#0f172a', fontSize: 15, fontWeight: '700'},
  dangerButton: {minHeight: 52, borderRadius: 12, backgroundColor: '#fff1f0', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, marginTop: 10},
  dangerButtonText: {color: '#dc2626', fontSize: 15, fontWeight: '700'},
});