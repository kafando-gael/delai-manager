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

SplashScreen.preventAutoHideAsync().catch(() => {});

const LOGO = require('./assets/app-logo.png');
const APP_NAME = 'Gestionnaire de Délai';
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
  {days: 0, label: 'Le jour même'},
  {days: 1, label: '1 jour avant'},
  {days: 3, label: '3 jours avant'},
  {days: 7, label: '1 semaine avant'},
  {days: 14, label: '2 semaines avant'},
  {days: 30, label: '1 mois avant'},
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

const CATEGORY_OPTIONS = [
  ['Admin', 'Administratif (passeport, visa...)'],
  ['Maison', 'Maison / logement'],
  ['Santé', 'Santé'],
  ['Voiture', 'Voiture / transport'],
  ['Travail', 'Travail / études'],
];

const USAGE_REASONS = [
  ['admin', 'Documents administratifs'],
  ['personal', 'Organisation personnelle'],
  ['family', 'Famille / foyer'],
  ['work', 'Travail / etudes'],
  ['other', 'Autre'],
];

const AGE_RANGES = [
  ['under18', 'Moins de 18 ans'],
  ['18-24', '18-24 ans'],
  ['25-34', '25-34 ans'],
  ['35-44', '35-44 ans'],
  ['45plus', '45 ans et plus'],
];

const ONBOARDING_SLIDES = [
  {
    title: 'Toutes tes echeances',
    copy: 'Centralise passeport, loyer, assurance et documents importants au meme endroit.',
    image: require('./assets/onboarding-1-deadlines.png'),
  },
  {
    title: 'Ne rate plus rien',
    copy: 'Repere les dates critiques, surveille les echeances a venir et reste toujours a jour.',
    image: require('./assets/onboarding-2-reminders.png'),
  },
  {
    title: 'Simple et local',
    copy: 'Tes donnees restent sur ton telephone. Commence en quelques secondes.',
    image: require('./assets/onboarding-3-local.png'),
  },
];

function generateDeviceId() {
  return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

function formatDate(value) {
  const date = parseDate(value);
  if (!date) {
    return value;
  }
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function distanceLabel(value) {
  const days = daysBefore(value);
  if (days < 0) {
    const late = Math.abs(days);
    return `depuis ${late} jour${late > 1 ? 's' : ''}`;
  }
  if (days === 0) {
    return "aujourd'hui";
  }
  if (days === 1) {
    return 'demain';
  }
  return `dans ${days} jours`;
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

function statusFor(deadline, settings) {
  const days = daysBefore(deadline.dueDate);
  if (days < 0) {
    return {id: 'expired', label: 'En retard', color: C.red, barColor: C.red};
  }
  if (days <= settings.criticalDays) {
    return {id: 'critical', label: 'Urgent', color: C.orange, barColor: C.orange};
  }
  if (days <= settings.watchDays) {
    return {id: 'watch', label: 'A venir', color: C.blue, barColor: C.blue};
  }
  return {id: 'ok', label: 'A jour', color: C.green, barColor: C.blue};
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

function repetitionLabel(value) {
  if (value === 'monthly') {
    return 'Mensuelle';
  }
  if (value === 'yearly') {
    return 'Annuelle';
  }
  return 'Aucune';
}

function remindersLabel(item) {
  const offsets = item.reminderOffsets || [];
  if (!offsets.length) {
    return 'Desactives';
  }
  const time = formatReminderTime(item.reminderHour ?? 9, item.reminderMinute ?? 0);
  return `A ${time} · ${offsets.map(offsetLabel).join(', ')}`;
}

function offsetLabel(days) {
  if (days === 0) {
    return 'jour même';
  }
  if (days === 1) {
    return '1 jour avant';
  }
  if (days === 7) {
    return '1 semaine avant';
  }
  if (days === 30) {
    return '1 mois avant';
  }
  return `${days} jours avant`;
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

function monthLabel(year, month) {
  return new Intl.DateTimeFormat('fr-FR', {month: 'long', year: 'numeric'}).format(new Date(year, month, 1));
}

function groupDeadlinesForHome(deadlines, settings) {
  const groups = [
    {id: 'expired', title: 'En retard', items: []},
    {id: 'critical', title: 'Urgent', items: []},
    {id: 'upcoming', title: 'A venir', items: []},
  ];

  for (const item of deadlines) {
    const status = statusFor(item, settings);
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
        if (loaded?.notificationsEnabled) {
          await requestNotificationPermissions();
          await syncAllDeadlineNotifications(loaded.deadlines, true);
        }
        setReady(true);
        await SplashScreen.hideAsync();
      }
    }

    boot().catch(async error => {
      await SplashScreen.hideAsync();
      Alert.alert('Erreur', `Impossible de charger ${APP_NAME} : ${error.message}`);
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
        email: profileData.email || `${deviceIdValue}@delaimanager.local`,
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
      const nextProfile = {
        name: profileRow.name,
        email: profileRow.email || '',
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
    };
    setSettings(nextSettings);
    setDeadlines(mappedDeadlines);
    await syncSubscription(deviceIdValue, nextTrialStartedAt);
    return {deadlines: mappedDeadlines, notificationsEnabled: nextSettings.notificationsEnabled};
  }

  const sortedDeadlines = useMemo(
    () => [...deadlines].sort((a, b) => parseDate(a.dueDate) - parseDate(b.dueDate)),
    [deadlines],
  );

  const domainSuggestions = useMemo(() => {
    const names = deadlines
      .map(item => item.domain)
      .filter(name => name && name !== 'Sans domaine' && name !== 'Sans catégorie');
    return [...new Set(names)].slice(0, 8);
  }, [deadlines]);

  const stats = useMemo(() => {
    return {
      upcoming: deadlines.filter(item => daysBefore(item.dueDate) >= 0).length,
      critical: deadlines.filter(item => statusFor(item, settings).id === 'critical').length,
      expired: deadlines.filter(item => statusFor(item, settings).id === 'expired').length,
    };
  }, [deadlines, settings]);

  async function completeIntro() {
    await db.runAsync('UPDATE app_settings SET intro_completed = 1 WHERE id = 1');
    setSettings(current => ({...current, introCompleted: true}));
    setOnboardingSlide(0);
  }

  async function createProfile() {
    const name = accessForm.name.trim();
    const usageReason = accessForm.usageReason;
    const ageRange = accessForm.ageRange;
    if (!name) {
      Alert.alert('Information manquante', 'Indique ton nom.');
      return;
    }
    if (!usageReason) {
      Alert.alert('Information manquante', 'Selectionne une raison d\'utilisation.');
      return;
    }
    if (!ageRange) {
      Alert.alert('Information manquante', 'Selectionne ta tranche d\'age.');
      return;
    }
    if (!accessForm.termsAccepted) {
      Alert.alert('Conditions requises', 'Accepte les termes et conditions d\'utilisation pour continuer.');
      return;
    }
    const email = accessForm.email.trim() || `${deviceId}@delaimanager.local`;
    const trialStart = new Date().toISOString();
    await db.runAsync(
      `INSERT OR REPLACE INTO profile
        (id, name, access_hint, access_code, email, phone, usage_reason, age_range, terms_accepted)
       VALUES (1, ?, '', '', ?, '', ?, ?, 1)`,
      name,
      email,
      usageReason,
      ageRange,
    );
    await db.runAsync('UPDATE app_settings SET trial_started_at = ? WHERE id = 1', trialStart);
    setTrialStartedAt(trialStart);
    const nextProfile = {
      name,
      email,
      phone: '',
      usageReason,
      ageRange,
      termsAccepted: true,
    };
    await syncClientToServer(nextProfile);
    await loadData();
    Alert.alert(
      'Essai gratuit — 1 mois',
      `Bienvenue ${name} !\n\nTu as 1 mois d'essai avec jusqu'a ${TRIAL_DEADLINE_LIMIT} echeances.\n\nApres cette periode, tu pourras t'abonner (${SUBSCRIPTION_ANNUAL_FCFA.toLocaleString('fr-FR')} FCFA / an) pour continuer sans limite.`,
      [{text: 'Compris'}],
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
      Alert.alert('Titre requis', 'Ajoute un titre pour cette echeance.');
      return;
    }
    if (!parseDate(form.dueDate)) {
      Alert.alert('Date invalide', 'Choisis une date d\'echeance.');
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
        });
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
      await scheduleDeadlineNotifications(renewed);
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
           default_reminder_hour = ?, default_reminder_minute = ?, default_reminder_offsets = ?
       WHERE id = 1`,
      next.criticalDays,
      next.watchDays,
      next.notificationsEnabled ? 1 : 0,
      next.defaultReminderHour,
      next.defaultReminderMinute,
      JSON.stringify(next.defaultReminderOffsets),
    );
    setSettings(next);
    if ('notificationsEnabled' in patch) {
      if (next.notificationsEnabled) {
        const granted = await requestNotificationPermissions();
        if (granted) {
          await syncAllDeadlineNotifications(deadlines, true);
        }
      } else {
        await syncAllDeadlineNotifications(deadlines, false);
      }
    }
  }

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

  async function beginSubscriptionPayment() {
    setPaymentLoading(true);
    try {
      const result = await startSubscriptionPayment({
        deviceId,
        customerEmail: profile?.email || `${deviceId}@delaimanager.local`,
        customerName: profile?.name || 'Utilisateur',
        customerPhone: profile?.phone || '',
        usageReason: profile?.usageReason || '',
        ageRange: profile?.ageRange || '',
      });
      if (!result.paymentUrl) {
        throw new Error('Lien de paiement manquant');
      }
      setPendingPaymentId(result.paymentId);
      setPaymentUrl(result.paymentUrl);
      setShowPaywall(false);
    } catch (error) {
      Alert.alert('Paiement', error.message || 'Impossible de demarrer le paiement.');
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
        Alert.alert('Abonnement actif', 'Tu peux maintenant ajouter autant d\'echeances que tu veux pendant 1 an.');
      } else {
        Alert.alert('Paiement en cours', 'Ton paiement est en traitement. Reessaie dans quelques instants.');
      }
    } catch {
      setPaymentUrl(null);
      setPendingPaymentId(null);
      Alert.alert('Verification', 'Impossible de confirmer le paiement pour le moment.');
    }
  }

  if (!ready) {
    return <LoadingScreen />;
  }

  if (!settings.introCompleted) {
    return (
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
      />
    );
  }

  if (!profile) {
    return (
      <AccessScreen
        accessForm={accessForm}
        setAccessForm={setAccessForm}
        createProfile={createProfile}
      />
    );
  }

  const todayLabel = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date());

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
      <View style={styles.appShell}>
        <View style={styles.appHeader}>
          <View style={styles.appHeaderBrand}>
            <Image source={LOGO} style={styles.appHeaderLogo} />
            <Text style={styles.appHeaderName}>DelaiManager</Text>
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
              domainSuggestions={domainSuggestions}
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
              domainSuggestions={domainSuggestions}
              updateSettings={updateSettings}
              onSubscribe={() => setShowPaywall(true)}
              onRefreshSubscription={() => syncSubscription()}
            />
          ) : null}
        </View>

        <View style={styles.tabBar}>
          <TabButton id="home" label="Accueil" icon="home" activeTab={activeTab} setActiveTab={setActiveTab} />
          <TabButton id="calendar" label="Calendrier" icon="calendar" activeTab={activeTab} setActiveTab={setActiveTab} />
          <View style={styles.fabWrapper}>
            <Pressable style={styles.fab} onPress={openAddDeadline}>
              <Ionicons name="add" size={24} color="#ffffff" />
              <Text style={styles.fabLabel}>Nouveau{'\n'}Délai</Text>
            </Pressable>
          </View>
          <TabButton id="settings" label="Reglages" icon="settings" activeTab={activeTab} setActiveTab={setActiveTab} />
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
  return (
    <SafeAreaView style={styles.loadingScreen}>
      <View style={styles.loadingBrand}>
        <Image source={LOGO} style={styles.loadingLogo} />
        <Text style={styles.loadingBrandName}>DelaiManager</Text>
      </View>
      <ActivityIndicator color={C.blue} style={{marginTop: 28}} />
      <Text style={styles.loadingText}>Chargement...</Text>
    </SafeAreaView>
  );
}

function OnboardingScreen({slide, onNext, onSkip}) {
  const current = ONBOARDING_SLIDES[slide];
  const isLast = slide === ONBOARDING_SLIDES.length - 1;

  return (
    <SafeAreaView style={styles.onboardingScreen}>
      <StatusBar barStyle="dark-content" backgroundColor="#F8FAFC" />
      <View style={styles.onboardingTopBar}>
        <Pressable onPress={onSkip}>
          <Text style={styles.onboardingSkip}>Passer</Text>
        </Pressable>
      </View>

      <View style={styles.onboardingBody}>
        <Image source={current.image} style={styles.onboardingIllustration} />
        <Text style={styles.onboardingTitle}>{current.title}</Text>
        <Text style={styles.onboardingCopy}>{current.copy}</Text>
      </View>

      <View style={styles.onboardingFooter}>
        <View style={styles.onboardingDots}>
          {ONBOARDING_SLIDES.map((_, index) => (
            <View key={index} style={[styles.onboardingDot, index === slide && styles.onboardingDotActive]} />
          ))}
        </View>
        <PrimaryButton label={isLast ? 'Commencer' : 'Suivant'} onPress={onNext} />
      </View>
    </SafeAreaView>
  );
}

function AccessScreen(props) {
  return (
    <SafeAreaView style={styles.accessScreen}>
      <StatusBar barStyle="dark-content" backgroundColor="#F8FAFC" />
      <ScrollView contentContainerStyle={styles.accessScroll} keyboardShouldPersistTaps="handled">
        <View style={styles.accessPanel}>
          <Image source={LOGO} style={styles.accessLogo} />
          <Text style={styles.accessTitle}>{`Bienvenue dans ${APP_NAME}`}</Text>
          <Text style={styles.accessCopy}>
            Quelques infos pour personnaliser ton experience.
          </Text>
          <View style={styles.trialBanner}>
            <Text style={styles.trialBannerTitle}>Essai gratuit inclus</Text>
            <Text style={styles.trialBannerCopy}>
              1 mois pour tester · jusqu'a {TRIAL_DEADLINE_LIMIT} echeances.
              Ensuite, un abonnement sera necessaire pour continuer sans limite.
            </Text>
          </View>

          <Input
            label="Ton nom"
            value={props.accessForm.name}
            onChangeText={value => props.setAccessForm(current => ({...current, name: value}))}
          />
          <Input
            label="Email"
            value={props.accessForm.email}
            placeholder="Facultatif"
            onChangeText={value => props.setAccessForm(current => ({...current, email: value}))}
          />
          <Dropdown
            label="Raison d'utilisation"
            value={props.accessForm.usageReason}
            options={USAGE_REASONS}
            placeholder="Selectionne une raison"
            onChange={value => props.setAccessForm(current => ({...current, usageReason: value}))}
          />
          <Dropdown
            label="Tranche d'age"
            value={props.accessForm.ageRange}
            options={AGE_RANGES}
            placeholder="Selectionne ta tranche d'age"
            onChange={value => props.setAccessForm(current => ({...current, ageRange: value}))}
          />
          <TermsRow
            accepted={props.accessForm.termsAccepted}
            onToggle={() =>
              props.setAccessForm(current => ({...current, termsAccepted: !current.termsAccepted}))
            }
          />
          <PrimaryButton label={`Entrer dans ${APP_NAME}`} onPress={props.createProfile} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CalendarScreen({deadlines, settings, onPressDeadline}) {
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
  const weekdayLabels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

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
        <Text style={styles.pageTitle}>Calendrier</Text>
        <Pressable style={styles.calendarTodayButton} onPress={goToToday}>
          <Text style={styles.calendarTodayButtonText}>Aujourd'hui</Text>
        </Pressable>
      </View>

      <View style={styles.calendarStatsBar}>
        <Text style={styles.calendarStatsText}>
          {monthDeadlines.length} echeance{monthDeadlines.length > 1 ? 's' : ''} ce mois
        </Text>
      </View>

      <View style={styles.calendarCard}>
        <View style={styles.calendarNav}>
          <Pressable style={styles.calendarNavButton} onPress={() => shiftMonth(-1)}>
            <Ionicons name="chevron-back" size={20} color="#0f172a" />
          </Pressable>
          <Text style={styles.calendarMonthLabel}>{monthLabel(viewYear, viewMonth)}</Text>
          <Pressable style={styles.calendarNavButton} onPress={() => shiftMonth(1)}>
            <Ionicons name="chevron-forward" size={20} color="#0f172a" />
          </Pressable>
        </View>

        <View style={styles.calendarLegend}>
          <View style={styles.calendarLegendItem}>
            <View style={[styles.calendarLegendDot, {backgroundColor: C.red}]} />
            <Text style={styles.calendarLegendText}>En retard</Text>
          </View>
          <View style={styles.calendarLegendItem}>
            <View style={[styles.calendarLegendDot, {backgroundColor: C.orange}]} />
            <Text style={styles.calendarLegendText}>Urgent</Text>
          </View>
          <View style={styles.calendarLegendItem}>
            <View style={[styles.calendarLegendDot, {backgroundColor: C.blue}]} />
            <Text style={styles.calendarLegendText}>A venir</Text>
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
            const dominantStatus = dayDeadlines.length ? statusFor(dayDeadlines[0], settings) : null;

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
                      const status = statusFor(item, settings);
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

      <Text style={styles.calendarSectionTitle}>Jour selectionne</Text>
      <Text style={styles.calendarSelectedLabel}>{formatDate(selectedDate)}</Text>

      {selectedDeadlines.length ? (
        selectedDeadlines.map(item => (
          <CalendarDeadlineRow key={item.id} item={item} settings={settings} onPress={() => onPressDeadline(item)} />
        ))
      ) : (
        <View style={styles.calendarEmpty}>
          <Text style={styles.calendarEmptyText}>Aucune echeance ce jour-la.</Text>
        </View>
      )}

      <Text style={styles.calendarSectionTitle}>Tout le mois</Text>
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
          <Text style={styles.calendarEmptyText}>Aucune echeance ce mois-ci.</Text>
        </View>
      )}
    </ScrollView>
  );
}

function CalendarDeadlineRow({item, settings, onPress, showDate}) {
  const status = statusFor(item, settings);
  return (
    <Pressable style={styles.calendarDeadlineRow} onPress={onPress}>
      <View style={[styles.calendarDeadlineDot, {backgroundColor: status.barColor}]} />
      <View style={styles.calendarDeadlineBody}>
        <Text style={styles.calendarDeadlineTitle}>{item.title}</Text>
        <Text style={styles.calendarDeadlineMeta}>
          {showDate ? `${formatDate(item.dueDate)} · ` : ''}
          {item.domain ? `${item.domain} · ` : ''}{distanceLabel(item.dueDate)}
        </Text>
      </View>
      <View style={[styles.homeStatusBadge, {backgroundColor: status.barColor + '18'}]}>
        <Text style={[styles.homeStatusBadgeText, {color: status.barColor}]}>{status.label}</Text>
      </View>
    </Pressable>
  );
}

function HomeScreen({profile, stats, deadlines, settings, todayLabel, onPressDeadline, onAdd, onOpenCalendar}) {
  const hasUrgent = stats.critical > 0 || stats.expired > 0;
  const summary = hasUrgent
    ? `${stats.critical + stats.expired} echeance${stats.critical + stats.expired > 1 ? 's' : ''} necessite${stats.critical + stats.expired > 1 ? 'nt' : ''} ton attention`
    : `Tout est a jour — ${stats.upcoming} echeance${stats.upcoming > 1 ? 's' : ''} a venir`;

  const sections = groupDeadlinesForHome(deadlines, settings).map(group => ({
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
            <Text style={styles.homeGreeting}>Bonjour, {profile.name}</Text>
            <Text style={styles.homeToday}>{todayLabel}</Text>
            <Text style={styles.homeSummary}>{summary}</Text>
          </View>
          <Pressable style={styles.homeCalendarButton} onPress={onOpenCalendar}>
            <Ionicons name="calendar" size={18} color="#2563EB" />
            <Text style={styles.homeCalendarButtonText}>Calendrier</Text>
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
          <Text style={styles.homeEmptyTitle}>Aucune echeance</Text>
          <Text style={styles.homeEmptyCopy}>Ajoute ta premiere date importante.</Text>
          <Pressable style={styles.homeEmptyButton} onPress={onAdd}>
            <Text style={styles.homeEmptyButtonText}>Ajouter une echeance</Text>
          </Pressable>
        </View>
      }
    />
  );
}

function HomeDeadlineRow({item, settings, onPress}) {
  const status = statusFor(item, settings);
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
            {item.domain ? `${item.domain} · ` : ''}{distanceLabel(item.dueDate)}
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
        <Text style={styles.progressDate}>{distanceLabel(item.dueDate)}</Text>
      </View>
    </Pressable>
  );
}

function AddScreen({form, settings, domainSuggestions, updateForm, saveDeadline, onCancel}) {
  const isEditing = Boolean(form.id);
  const presetIds = new Set(CATEGORY_OPTIONS.map(([id]) => id));
  const categoryOptions = [
    ['', 'Aucun'],
    ...CATEGORY_OPTIONS,
    ...domainSuggestions.filter(name => !presetIds.has(name)).map(name => [name, name]),
  ];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.formContent}>
      <Text style={styles.pageTitle}>{isEditing ? 'Modifier l\'échéance' : 'Nouvelle échéance'}</Text>

      <Input
        label="Titre"
        value={form.title}
        placeholder="Ex : Passeport, Loyer, Assurance..."
        onChangeText={value => updateForm('title', value)}
      />
      <DatePickerField
        label="Date d'échéance"
        value={form.dueDate}
        onChange={value => updateForm('dueDate', value)}
      />

      <Dropdown
        label="Type"
        value={form.domain}
        options={categoryOptions}
        placeholder="Choisir (facultatif)"
        onChange={value => updateForm('domain', value)}
      />

      <Input
        label="Note"
        value={form.note}
        multiline
        placeholder="Facultatif"
        onChangeText={value => updateForm('note', value)}
      />

      <Text style={styles.fieldLabel}>Se répète ?</Text>
      <SegmentedControl
        value={form.repetition}
        options={[
          ['none', 'Non'],
          ['monthly', 'Mensuelle'],
          ['yearly', 'Annuelle'],
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
        label={isEditing ? 'Enregistrer les modifications' : 'Enregistrer'}
        onPress={saveDeadline}
      />
      {isEditing ? (
        <Pressable style={styles.secondaryFullButton} onPress={onCancel}>
          <Text style={styles.secondaryButtonText}>Annuler</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function SettingsScreen({profile, settings, stats, deadlines, subscription, domainSuggestions, updateSettings, onSubscribe, onRefreshSubscription}) {
  const priceLabel = `${SUBSCRIPTION_ANNUAL_FCFA.toLocaleString('fr-FR')} FCFA / an`;
  const used = deadlines.length;
  const limit = subscription.isTrialActive ? TRIAL_DEADLINE_LIMIT : 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.formContent}>
      <Text style={styles.pageTitle}>Reglages</Text>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>Profil local</Text>
        <Text style={styles.deadlineMeta}>{profile.name}</Text>
        {profile.email ? <Text style={styles.deadlineMeta}>{profile.email}</Text> : null}
        {profile.usageReason ? (
          <Text style={styles.deadlineMeta}>
            {labelForOption(USAGE_REASONS, profile.usageReason)}
            {profile.ageRange ? ` · ${labelForOption(AGE_RANGES, profile.ageRange)}` : ''}
          </Text>
        ) : null}
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>Abonnement</Text>
        {subscription.isActive ? (
          <>
            <Text style={styles.settingsValue}>Actif</Text>
            <Text style={styles.deadlineMeta}>
              {subscription.daysLeft} jour{subscription.daysLeft > 1 ? 's' : ''} restant{subscription.daysLeft > 1 ? 's' : ''}
              {subscription.endsAt ? ` · jusqu'au ${formatDate(subscription.endsAt.slice(0, 10))}` : ''}
            </Text>
            <Text style={styles.deadlineMeta}>Echeances illimitees</Text>
          </>
        ) : subscription.isTrialActive ? (
          <>
            <Text style={styles.settingsValue}>Essai gratuit</Text>
            <Text style={styles.deadlineMeta}>
              {subscription.trialDaysLeft} jour{subscription.trialDaysLeft > 1 ? 's' : ''} restant{subscription.trialDaysLeft > 1 ? 's' : ''}
              {subscription.trialEndsAt
                ? ` · jusqu'au ${formatDate(subscription.trialEndsAt.slice(0, 10))}`
                : ''}
            </Text>
            <Text style={styles.deadlineMeta}>
              Jusqu'a {TRIAL_DEADLINE_LIMIT} echeances · {used}/{TRIAL_DEADLINE_LIMIT} utilisee{used > 1 ? 's' : ''}
            </Text>
            <Text style={styles.deadlineMeta}>
              Ensuite : abonnement {priceLabel} pour continuer sans limite.
            </Text>
            <Pressable style={styles.smallAction} onPress={onSubscribe}>
              <Text style={styles.smallActionText}>S'abonner maintenant — {priceLabel}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.settingsValue}>Essai termine</Text>
            <Text style={styles.deadlineMeta}>
              Abonne-toi pour ajouter de nouvelles echeances ({priceLabel}).
            </Text>
            <Text style={styles.deadlineMeta}>
              {used} echeance{used > 1 ? 's' : ''} enregistree{used > 1 ? 's' : ''}
              {limit === 0 ? ' · limite atteinte' : ''}
            </Text>
            <Pressable style={styles.smallAction} onPress={onSubscribe}>
              <Text style={styles.smallActionText}>S'abonner — {priceLabel}</Text>
            </Pressable>
          </>
        )}
        <Pressable style={styles.subscriptionRefresh} onPress={onRefreshSubscription}>
          <Text style={styles.subscriptionRefreshText}>Actualiser le statut</Text>
        </Pressable>
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>Notifications</Text>
        <ToggleRow
          label="Rappels locaux"
          value={settings.notificationsEnabled}
          onChange={value => updateSettings({notificationsEnabled: value})}
        />
        <Text style={styles.deadlineMeta}>Alertes sur ton telephone, sans Firebase.</Text>

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
        <Text style={styles.settingsTitle}>Seuils automatiques</Text>
        <Stepper
          label="Critique"
          value={settings.criticalDays}
          suffix="jours"
          decrease={() => updateSettings({criticalDays: Math.max(1, settings.criticalDays - 1)})}
          increase={() => updateSettings({criticalDays: settings.criticalDays + 1})}
        />
        <Stepper
          label="A surveiller"
          value={settings.watchDays}
          suffix="jours"
          decrease={() => updateSettings({watchDays: Math.max(settings.criticalDays + 1, settings.watchDays - 1)})}
          increase={() => updateSettings({watchDays: settings.watchDays + 1})}
        />
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>Donnees locales</Text>
        <Text style={styles.settingsValue}>{deadlines.length}</Text>
        <Text style={styles.deadlineMeta}>echeances sur ce telephone</Text>
        <Text style={styles.deadlineMeta}>{stats.upcoming} a venir · {stats.expired} depassees</Text>
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>Types récents</Text>
        <View style={styles.chipGrid}>
          {domainSuggestions.length ? (
            domainSuggestions.map(domain => (
              <View key={domain} style={styles.chipMuted}>
                <Text style={styles.chipText}>{domain}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.deadlineMeta}>Ils apparaitront apres tes premieres saisies.</Text>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function DeadlineModal({deadline, settings, close, onEdit, renewDeadline, deleteDeadline}) {
  if (!deadline) {
    return null;
  }
  const status = statusFor(deadline, settings);
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
            <Text style={styles.modalDate}>{formatDate(deadline.dueDate)}</Text>
            <Text style={styles.modalDistance}>{distanceLabel(deadline.dueDate)}</Text>
          </View>

          {deadline.note ? (
            <View style={styles.modalNoteBox}>
              <Text style={styles.modalNote}>{deadline.note}</Text>
            </View>
          ) : null}

          <View style={styles.modalMeta}>
            <View style={styles.modalMetaItem}>
              <Ionicons name="repeat-outline" size={14} color="#94a3b8" />
              <Text style={styles.modalMetaText}>{repetitionLabel(deadline.repetition)}</Text>
            </View>
            <View style={styles.modalMetaItem}>
              <Ionicons name="notifications-outline" size={14} color="#94a3b8" />
              <Text style={styles.modalMetaText}>{remindersLabel(deadline)}</Text>
            </View>
          </View>

          <View style={styles.modalActions}>
            <Pressable style={styles.modalDoneButton} onPress={handleDone}>
              <Ionicons name="checkmark-circle-outline" size={20} color="#ffffff" />
              <Text style={styles.modalDoneText}>
                {isRecurring ? 'Marquer comme fait — renouveler' : 'Marquer comme fait — archiver'}
              </Text>
            </Pressable>
            <Pressable style={styles.modalEditButton} onPress={() => onEdit(deadline)}>
              <Ionicons name="create-outline" size={18} color="#2563EB" />
              <Text style={styles.modalEditText}>Modifier</Text>
            </Pressable>
            <View style={styles.modalSecondaryRow}>
              <Pressable style={styles.modalDeleteButton} onPress={() => deleteDeadline(deadline)}>
                <Ionicons name="trash-outline" size={18} color="#dc2626" />
                <Text style={styles.modalDeleteText}>Supprimer</Text>
              </Pressable>
              <Pressable style={styles.modalCloseButton} onPress={close}>
                <Text style={styles.modalCloseText}>Fermer</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function SubscriptionPaywallModal({visible, subscription, loading, onClose, onSubscribe}) {
  const priceLabel = `${SUBSCRIPTION_ANNUAL_FCFA.toLocaleString('fr-FR')} FCFA / an`;
  const title = subscription?.isTrialActive ? 'Limite d\'essai atteinte' : 'Essai termine';
  const copy = subscription?.isTrialActive
    ? `Pendant ton essai d'1 mois, tu peux creer jusqu'a ${TRIAL_DEADLINE_LIMIT} echeances. Abonne-toi pour en ajouter autant que tu veux.`
    : `Ton essai d'1 mois est termine. Abonne-toi pour continuer a ajouter des echeances sans limite.`;

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
              Essai : encore {subscription.trialDaysLeft} jour{subscription.trialDaysLeft > 1 ? 's' : ''}
            </Text>
          ) : null}
          <View style={styles.paywallPriceBox}>
            <Text style={styles.paywallPrice}>{priceLabel}</Text>
            <Text style={styles.paywallPriceHint}>Tu saisiras ton numero sur la page de paiement</Text>
          </View>
          <PrimaryButton
            label={loading ? 'Chargement...' : `S'abonner — ${priceLabel}`}
            onPress={onSubscribe}
          />
          <Pressable style={styles.paywallClose} onPress={onClose}>
            <Text style={styles.paywallCloseText}>Plus tard</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function SubscriptionPaymentModal({paymentUrl, onClose, onComplete}) {
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
          <Text style={styles.paymentHeaderTitle}>Paiement abonnement</Text>
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
  return (
    <Pressable style={styles.termsRow} onPress={onToggle}>
      <View style={[styles.termsCheckbox, accepted && styles.termsCheckboxActive]}>
        {accepted ? <Text style={styles.termsCheckmark}>✓</Text> : null}
      </View>
      <Text style={styles.termsText}>J'accepte les termes et conditions d'utilisation</Text>
    </Pressable>
  );
}

function Input({label, value, onChangeText, placeholder, multiline}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.textArea]}
        value={value}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        multiline={multiline}
        onChangeText={onChangeText}
      />
    </View>
  );
}

function DatePickerField({label, value, onChange}) {
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
          {value ? formatDate(value) : 'Choisir une date'}
        </Text>
        <Ionicons name="calendar-outline" size={20} color="#64748b" />
      </Pressable>

      {Platform.OS === 'ios' ? (
        <Modal visible={show} transparent animationType="fade" onRequestClose={() => setShow(false)}>
          <Pressable style={styles.datePickerBackdrop} onPress={() => setShow(false)}>
            <Pressable style={styles.datePickerSheet} onPress={event => event.stopPropagation()}>
              <View style={styles.datePickerToolbar}>
                <Pressable onPress={() => setShow(false)}>
                  <Text style={styles.datePickerCancel}>Annuler</Text>
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
                locale="fr-FR"
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
            <Text style={styles.reminderPlannerTitle}>Rappels</Text>
            <Text style={styles.reminderPlannerHint}>Choisis l'heure et les moments qui te conviennent</Text>
          </View>
        </View>
      ) : (
        <Text style={styles.settingsSubtitle}>Preferences par defaut</Text>
      )}

      <Text style={styles.reminderSectionLabel}>A quelle heure ?</Text>
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

      <Text style={styles.reminderSectionLabel}>Me prevenir</Text>
      <View style={styles.reminderToggleList}>
        {REMINDER_PRESETS.map((preset, index) => (
          <View
            key={preset.days}
            style={[
              styles.reminderToggleRow,
              index === REMINDER_PRESETS.length - 1 && customOffsets.length === 0 && styles.reminderToggleRowLast,
            ]}>
            <Text style={styles.reminderToggleLabel}>{preset.label}</Text>
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
            <Text style={styles.reminderToggleLabel}>{offsetLabel(days)}</Text>
            <Pressable style={styles.reminderRemoveButton} onPress={() => removeOffset(days)}>
              <Ionicons name="close-circle" size={22} color="#94a3b8" />
            </Pressable>
          </View>
        ))}
      </View>

      {showAddCustom ? (
        <View style={styles.reminderAddBox}>
          <Stepper
            label="Jours avant l'echeance"
            value={newCustomDays}
            suffix="j"
            decrease={() => setNewCustomDays(current => Math.max(0, current - 1))}
            increase={() => setNewCustomDays(current => Math.min(365, current + 1))}
          />
          <View style={styles.reminderAddActions}>
            <Pressable style={styles.reminderAddCancel} onPress={() => setShowAddCustom(false)}>
              <Text style={styles.reminderAddCancelText}>Annuler</Text>
            </Pressable>
            <Pressable style={styles.reminderAddConfirm} onPress={addCustomOffset}>
              <Text style={styles.reminderAddConfirmText}>Ajouter</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable style={styles.reminderAddButton} onPress={() => setShowAddCustom(true)}>
          <Ionicons name="add-circle-outline" size={18} color="#2563EB" />
          <Text style={styles.reminderAddButtonText}>Ajouter un delai personnalise</Text>
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