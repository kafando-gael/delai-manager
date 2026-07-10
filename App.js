import React, {useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as SQLite from 'expo-sqlite';

const LOGO = require('./assets/app-logo.png');
const APP_NAME = 'Gestionnaire de Délai';
const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_FORM = {
  title: '',
  dueDate: '',
  domain: '',
  note: '',
  repetition: 'none',
  reminders: {day: true, week: true, month: false},
};

const SAMPLE_DEADLINES = [
  ['Passeport', 'Identite', '2026-07-06', 'Verifier les pieces avant le rendez-vous.', 'none', 1, 1, 0],
  ['Assurance voiture', 'Voiture', '2026-07-10', 'Renouveler avant expiration.', 'yearly', 1, 1, 1],
  ['Loyer', 'Maison', '2026-07-24', '', 'monthly', 1, 0, 0],
  ['Controle technique', 'Voiture', '2027-01-20', '', 'yearly', 0, 1, 1],
];

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

function statusFor(deadline, settings) {
  const days = daysBefore(deadline.dueDate);
  if (days < 0) {
    return {id: 'expired', label: 'Depassee', color: '#d92d20', background: '#fff1f0'};
  }
  if (days <= settings.criticalDays) {
    return {id: 'critical', label: 'Critique', color: '#d97706', background: '#fff7ed'};
  }
  if (days <= settings.watchDays) {
    return {id: 'watch', label: 'A surveiller', color: '#0e7490', background: '#ecfeff'};
  }
  return {id: 'ok', label: 'A jour', color: '#047857', background: '#ecfdf5'};
}

function nextDate(dueDate, repetition) {
  const date = parseDate(dueDate);
  if (!date) {
    return dueDate;
  }
  if (repetition === 'monthly') {
    date.setMonth(date.getMonth() + 1);
  }
  if (repetition === 'yearly') {
    date.setFullYear(date.getFullYear() + 1);
  }
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
  const labels = [];
  if (item.reminderDay) {
    labels.push('1 jour');
  }
  if (item.reminderWeek) {
    labels.push('1 semaine');
  }
  if (item.reminderMonth) {
    labels.push('1 mois');
  }
  return labels.length ? labels.join(', ') : 'Aucun';
}

function mapDeadline(row) {
  return {
    id: String(row.id),
    title: row.title,
    domain: row.category || '',
    dueDate: row.due_date,
    note: row.note || '',
    repetition: row.repetition,
    reminderDay: row.reminder_day,
    reminderWeek: row.reminder_week,
    reminderMonth: row.reminder_month,
  };
}

export default function App() {
  const [db, setDb] = useState(null);
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [activeTab, setActiveTab] = useState('home');
  const [profile, setProfile] = useState(null);
  const [settings, setSettings] = useState({criticalDays: 3, watchDays: 14, privacyLock: true});
  const [deadlines, setDeadlines] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [accessForm, setAccessForm] = useState({name: '', hint: '', code: ''});
  const [unlockCode, setUnlockCode] = useState('');
  const [selectedDeadline, setSelectedDeadline] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function boot() {
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

      await database.runAsync(
        `INSERT OR IGNORE INTO app_settings
          (id, critical_days, watch_days, privacy_lock)
         VALUES (1, 3, 14, 1)`,
      );

      const existing = await database.getFirstAsync('SELECT COUNT(*) AS count FROM deadlines');
      if (!existing?.count) {
        for (const item of SAMPLE_DEADLINES) {
          await database.runAsync(
            `INSERT INTO deadlines
              (title, category, due_date, note, repetition, reminder_day, reminder_week, reminder_month)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ...item,
          );
        }
      }

      if (mounted) {
        setDb(database);
        await loadData(database);
        setReady(true);
      }
    }

    boot().catch(error => {
      Alert.alert('Erreur', `Impossible de charger ${APP_NAME} : ${error.message}`);
    });

    return () => {
      mounted = false;
    };
  }, []);

  async function loadData(database = db) {
    if (!database) {
      return;
    }
    const profileRow = await database.getFirstAsync('SELECT * FROM profile WHERE id = 1');
    const settingsRow = await database.getFirstAsync('SELECT * FROM app_settings WHERE id = 1');
    const rows = await database.getAllAsync('SELECT * FROM deadlines ORDER BY due_date ASC, title ASC');

    setProfile(
      profileRow
        ? {
            name: profileRow.name,
            hint: profileRow.access_hint,
            code: profileRow.access_code,
          }
        : null,
    );
    setSettings({
      criticalDays: settingsRow?.critical_days ?? 3,
      watchDays: settingsRow?.watch_days ?? 14,
      privacyLock: Boolean(settingsRow?.privacy_lock ?? 1),
    });
    setDeadlines(rows.map(mapDeadline));

    if (profileRow && !settingsRow?.privacy_lock) {
      setUnlocked(true);
    }
  }

  const sortedDeadlines = useMemo(
    () => [...deadlines].sort((a, b) => parseDate(a.dueDate) - parseDate(b.dueDate)),
    [deadlines],
  );

  const domainSuggestions = useMemo(() => {
    const names = deadlines.map(item => item.domain).filter(Boolean);
    return [...new Set(names)].slice(0, 8);
  }, [deadlines]);

  const stats = useMemo(() => {
    return {
      upcoming: deadlines.filter(item => daysBefore(item.dueDate) >= 0).length,
      critical: deadlines.filter(item => statusFor(item, settings).id === 'critical').length,
      expired: deadlines.filter(item => statusFor(item, settings).id === 'expired').length,
    };
  }, [deadlines, settings]);

  async function createProfile() {
    const name = accessForm.name.trim();
    const hint = accessForm.hint.trim();
    const code = accessForm.code.trim();
    if (!name || !hint || !code) {
      Alert.alert('Information manquante', 'Indique ton nom, un repere et un code simple.');
      return;
    }
    await db.runAsync(
      `INSERT OR REPLACE INTO profile (id, name, access_hint, access_code)
       VALUES (1, ?, ?, ?)`,
      name,
      hint,
      code,
    );
    await loadData();
    setUnlocked(true);
  }

  function unlock() {
    if (unlockCode.trim() === profile?.code) {
      setUnlocked(true);
      setUnlockCode('');
      return;
    }
    Alert.alert('Acces refuse', 'Le code ne correspond pas.');
  }

  function updateForm(field, value) {
    setForm(current => ({...current, [field]: value}));
  }

  function updateReminder(field) {
    setForm(current => ({
      ...current,
      reminders: {...current.reminders, [field]: !current.reminders[field]},
    }));
  }

  async function saveDeadline() {
    if (!form.title.trim()) {
      Alert.alert('Titre requis', 'Ajoute un titre pour cette echeance.');
      return;
    }
    if (!parseDate(form.dueDate)) {
      Alert.alert('Date invalide', 'Utilise le format AAAA-MM-JJ.');
      return;
    }

    await db.runAsync(
      `INSERT INTO deadlines
        (title, category, due_date, note, repetition, reminder_day, reminder_week, reminder_month)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      form.title.trim(),
      form.domain.trim() || 'Sans domaine',
      form.dueDate,
      form.note.trim(),
      form.repetition,
      form.reminders.day ? 1 : 0,
      form.reminders.week ? 1 : 0,
      form.reminders.month ? 1 : 0,
    );

    setForm(EMPTY_FORM);
    await loadData();
    setActiveTab('home');
  }

  async function renewDeadline(deadline) {
    const renewedDate = nextDate(deadline.dueDate, deadline.repetition);
    await db.runAsync('UPDATE deadlines SET due_date = ? WHERE id = ?', renewedDate, deadline.id);
    await loadData();
    setSelectedDeadline({...deadline, dueDate: renewedDate});
  }

  async function deleteDeadline(deadline) {
    await db.runAsync('DELETE FROM deadlines WHERE id = ?', deadline.id);
    setSelectedDeadline(null);
    await loadData();
  }

  async function updateSettings(patch) {
    const next = {...settings, ...patch};
    await db.runAsync(
      `UPDATE app_settings
       SET critical_days = ?, watch_days = ?, privacy_lock = ?
       WHERE id = 1`,
      next.criticalDays,
      next.watchDays,
      next.privacyLock ? 1 : 0,
    );
    setSettings(next);
  }

  function renderDeadline({item}) {
    const status = statusFor(item, settings);
    return (
      <Pressable
        style={[styles.deadlineCard, {borderColor: status.background}]}
        onPress={() => setSelectedDeadline(item)}>
        <View style={[styles.statusRail, {backgroundColor: status.color}]} />
        <View style={styles.deadlineMain}>
          <View style={styles.cardTopline}>
            <Text style={styles.deadlineTitle}>{item.title}</Text>
            <View style={[styles.statusPill, {backgroundColor: status.background}]}>
              <Text style={[styles.statusText, {color: status.color}]}>{status.label}</Text>
            </View>
          </View>
          <Text style={styles.deadlineDate}>{distanceLabel(item.dueDate)} · {formatDate(item.dueDate)}</Text>
          <Text style={styles.deadlineMeta}>{item.domain}</Text>
          {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
        </View>
      </Pressable>
    );
  }

  if (!ready) {
    return <LoadingScreen />;
  }

  if (!profile) {
    return (
      <AccessScreen
        mode="create"
        accessForm={accessForm}
        setAccessForm={setAccessForm}
        createProfile={createProfile}
      />
    );
  }

  if (!unlocked) {
    return (
      <AccessScreen
        mode="unlock"
        profile={profile}
        unlockCode={unlockCode}
        setUnlockCode={setUnlockCode}
        unlock={unlock}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#f4f7f5" />
      <View style={styles.appShell}>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <Image source={LOGO} style={styles.headerLogo} />
            <View>
              <Text style={styles.brand}>{APP_NAME}</Text>
              <Text style={styles.slogan}>Bonjour {profile.name}</Text>
            </View>
          </View>
          <Pressable style={styles.addButton} onPress={() => setActiveTab('add')}>
            <Text style={styles.addButtonText}>+</Text>
          </Pressable>
        </View>

        <View style={styles.content}>
          {activeTab === 'home' ? (
            <HomeScreen stats={stats} deadlines={sortedDeadlines} renderDeadline={renderDeadline} />
          ) : null}
          {activeTab === 'add' ? (
            <AddScreen
              form={form}
              domainSuggestions={domainSuggestions}
              updateForm={updateForm}
              updateReminder={updateReminder}
              saveDeadline={saveDeadline}
            />
          ) : null}
          {activeTab === 'calendar' ? (
            <AgendaScreen deadlines={sortedDeadlines} renderDeadline={renderDeadline} />
          ) : null}
          {activeTab === 'reminders' ? <RemindersScreen deadlines={sortedDeadlines} /> : null}
          {activeTab === 'settings' ? (
            <SettingsScreen
              profile={profile}
              settings={settings}
              stats={stats}
              deadlines={deadlines}
              domainSuggestions={domainSuggestions}
              updateSettings={updateSettings}
              lock={() => setUnlocked(false)}
            />
          ) : null}
        </View>

        <View style={styles.tabBar}>
          <TabButton id="home" label="Accueil" activeTab={activeTab} setActiveTab={setActiveTab} />
          <TabButton id="add" label="Ajouter" activeTab={activeTab} setActiveTab={setActiveTab} />
          <TabButton id="calendar" label="Agenda" activeTab={activeTab} setActiveTab={setActiveTab} />
          <TabButton id="reminders" label="Rappels" activeTab={activeTab} setActiveTab={setActiveTab} />
          <TabButton id="settings" label="Reglages" activeTab={activeTab} setActiveTab={setActiveTab} />
        </View>
      </View>

      <DeadlineModal
        deadline={selectedDeadline}
        settings={settings}
        close={() => setSelectedDeadline(null)}
        renewDeadline={renewDeadline}
        deleteDeadline={deleteDeadline}
      />
    </SafeAreaView>
  );
}

function LoadingScreen() {
  return (
    <SafeAreaView style={styles.loadingScreen}>
      <Image source={LOGO} style={styles.splashLogo} />
      <ActivityIndicator color="#0f766e" />
      <Text style={styles.loadingText}>{APP_NAME} se prepare...</Text>
    </SafeAreaView>
  );
}

function AccessScreen(props) {
  const isCreate = props.mode === 'create';
  return (
    <SafeAreaView style={styles.accessScreen}>
      <StatusBar barStyle="dark-content" backgroundColor="#f4f7f5" />
      <View style={styles.accessPanel}>
        <Image source={LOGO} style={styles.accessLogo} />
        <Text style={styles.accessTitle}>{isCreate ? `Bienvenue dans ${APP_NAME}` : `Bonjour ${props.profile.name}`}</Text>
        <Text style={styles.accessCopy}>
          {isCreate
            ? 'Un acces local simple protege tes echeances sur ce telephone.'
            : `Repere : ${props.profile.hint}`}
        </Text>

        {isCreate ? (
          <>
            <Input
              label="Ton nom"
              value={props.accessForm.name}
              onChangeText={value => props.setAccessForm(current => ({...current, name: value}))}
            />
            <Input
              label="Repere personnel"
              value={props.accessForm.hint}
              placeholder="Ex: mon surnom"
              onChangeText={value => props.setAccessForm(current => ({...current, hint: value}))}
            />
            <Input
              label="Code d'acces"
              value={props.accessForm.code}
              placeholder="Simple, local, memorisable"
              onChangeText={value => props.setAccessForm(current => ({...current, code: value}))}
            />
            <PrimaryButton label={`Entrer dans ${APP_NAME}`} onPress={props.createProfile} />
          </>
        ) : (
          <>
            <Input
              label="Code d'acces"
              value={props.unlockCode}
              onChangeText={props.setUnlockCode}
            />
            <PrimaryButton label="Debloquer" onPress={props.unlock} />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function HomeScreen({stats, deadlines, renderDeadline}) {
  return (
    <View style={styles.screen}>
      <View style={styles.heroPanel}>
        <Text style={styles.heroKicker}>Vue rapide</Text>
        <Text style={styles.heroTitle}>{stats.upcoming} echeances a venir</Text>
        <Text style={styles.heroCopy}>
          {stats.critical} critiques · {stats.expired} depassees
        </Text>
      </View>

      <View style={styles.statsRow}>
        <StatBox value={stats.upcoming} label="A venir" tone="#2563eb" />
        <StatBox value={stats.critical} label="Critiques" tone="#d97706" />
        <StatBox value={stats.expired} label="Depassees" tone="#d92d20" />
      </View>

      <FlatList
        data={deadlines}
        keyExtractor={item => item.id}
        renderItem={renderDeadline}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={<Text style={styles.sectionTitle}>Prochaines dates</Text>}
        ListEmptyComponent={<Text style={styles.emptyText}>Aucune echeance enregistree.</Text>}
      />
    </View>
  );
}

function AddScreen({form, domainSuggestions, updateForm, updateReminder, saveDeadline}) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.formContent}>
      <Text style={styles.sectionTitle}>Nouvelle echeance</Text>
      <Input label="Titre" value={form.title} onChangeText={value => updateForm('title', value)} />
      <Input
        label="Date"
        value={form.dueDate}
        placeholder="AAAA-MM-JJ"
        onChangeText={value => updateForm('dueDate', value)}
      />
      <Input
        label="Domaine"
        value={form.domain}
        placeholder="Libre : maison, visa, sante..."
        onChangeText={value => updateForm('domain', value)}
      />

      {domainSuggestions.length ? (
        <View style={styles.suggestionBlock}>
          <Text style={styles.microLabel}>Suggestions recentes</Text>
          <View style={styles.chipGrid}>
            {domainSuggestions.map(domain => (
              <Pressable key={domain} style={styles.chip} onPress={() => updateForm('domain', domain)}>
                <Text style={styles.chipText}>{domain}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <Input
        label="Note"
        value={form.note}
        multiline
        placeholder="Facultatif"
        onChangeText={value => updateForm('note', value)}
      />

      <Text style={styles.fieldLabel}>Repetition</Text>
      <SegmentedControl
        value={form.repetition}
        options={[
          ['none', 'Non'],
          ['monthly', 'Mensuelle'],
          ['yearly', 'Annuelle'],
        ]}
        onChange={value => updateForm('repetition', value)}
      />

      <Text style={styles.fieldLabel}>Rappels</Text>
      <ToggleRow label="1 jour avant" value={form.reminders.day} onChange={() => updateReminder('day')} />
      <ToggleRow label="1 semaine avant" value={form.reminders.week} onChange={() => updateReminder('week')} />
      <ToggleRow label="1 mois avant" value={form.reminders.month} onChange={() => updateReminder('month')} />

      <PrimaryButton label="Enregistrer" onPress={saveDeadline} />
    </ScrollView>
  );
}

function AgendaScreen({deadlines, renderDeadline}) {
  const grouped = deadlines.reduce((groups, item) => {
    const date = parseDate(item.dueDate);
    const key = date
      ? new Intl.DateTimeFormat('fr-FR', {month: 'long', year: 'numeric'}).format(date)
      : 'Sans date';
    return {...groups, [key]: [...(groups[key] || []), item]};
  }, {});

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.listContent}>
      <Text style={styles.sectionTitle}>Agenda</Text>
      {Object.entries(grouped).map(([month, items]) => (
        <View key={month} style={styles.monthBlock}>
          <Text style={styles.monthTitle}>{month}</Text>
          {items.map(item => (
            <View key={item.id}>{renderDeadline({item})}</View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function RemindersScreen({deadlines}) {
  const reminders = deadlines.flatMap(item => {
    const days = daysBefore(item.dueDate);
    const rows = [];
    if (item.reminderMonth && days <= 30 && days >= 0) {
      rows.push({id: `${item.id}-month`, title: item.title, label: '1 mois avant', days});
    }
    if (item.reminderWeek && days <= 7 && days >= 0) {
      rows.push({id: `${item.id}-week`, title: item.title, label: '1 semaine avant', days});
    }
    if (item.reminderDay && days <= 1 && days >= 0) {
      rows.push({id: `${item.id}-day`, title: item.title, label: '1 jour avant', days});
    }
    return rows;
  });

  return (
    <View style={styles.screen}>
      <Text style={styles.sectionTitle}>Rappels actifs</Text>
      {reminders.length ? (
        <FlatList
          data={reminders}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({item}) => (
            <View style={styles.softCard}>
              <Text style={styles.deadlineTitle}>{item.title}</Text>
              <Text style={styles.deadlineMeta}>
                {item.label} · {item.days === 0 ? "aujourd'hui" : `dans ${item.days} jours`}
              </Text>
            </View>
          )}
        />
      ) : (
        <Text style={styles.emptyText}>Aucun rappel actif pour le moment.</Text>
      )}
    </View>
  );
}

function SettingsScreen({profile, settings, stats, deadlines, domainSuggestions, updateSettings, lock}) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.formContent}>
      <Text style={styles.sectionTitle}>Reglages</Text>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>Profil local</Text>
        <Text style={styles.deadlineMeta}>{profile.name} · repere : {profile.hint}</Text>
        <Pressable style={styles.smallAction} onPress={lock}>
          <Text style={styles.smallActionText}>Verrouiller maintenant</Text>
        </Pressable>
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
        <View style={styles.toggleRowPlain}>
          <View>
            <Text style={styles.settingsTitle}>Verrou au lancement</Text>
            <Text style={styles.deadlineMeta}>Demander le code a chaque ouverture</Text>
          </View>
          <Switch
            value={settings.privacyLock}
            onValueChange={value => updateSettings({privacyLock: value})}
          />
        </View>
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>Donnees locales</Text>
        <Text style={styles.settingsValue}>{deadlines.length}</Text>
        <Text style={styles.deadlineMeta}>echeances sur ce telephone</Text>
        <Text style={styles.deadlineMeta}>{stats.upcoming} a venir · {stats.expired} depassees</Text>
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.settingsTitle}>Domaines recents</Text>
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

function DeadlineModal({deadline, settings, close, renewDeadline, deleteDeadline}) {
  if (!deadline) {
    return null;
  }
  const status = statusFor(deadline, settings);
  const canRenew = deadline.repetition !== 'none';

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalPanel}>
          <View style={[styles.modalHandle]} />
          <Text style={styles.modalTitle}>{deadline.title}</Text>
          <Text style={[styles.modalStatus, {color: status.color}]}>
            {status.label} · {distanceLabel(deadline.dueDate)}
          </Text>
          <Text style={styles.deadlineMeta}>{deadline.domain}</Text>
          <Text style={styles.modalDate}>{formatDate(deadline.dueDate)}</Text>
          {deadline.note ? <Text style={styles.modalNote}>{deadline.note}</Text> : null}
          <Text style={styles.deadlineMeta}>Rappels : {remindersLabel(deadline)}</Text>
          <Text style={styles.deadlineMeta}>Repetition : {repetitionLabel(deadline.repetition)}</Text>

          {canRenew ? <PrimaryButton label="Marquer comme renouvelee" onPress={() => renewDeadline(deadline)} /> : null}
          <Pressable style={styles.dangerButton} onPress={() => deleteDeadline(deadline)}>
            <Text style={styles.dangerButtonText}>Supprimer</Text>
          </Pressable>
          <Pressable style={styles.secondaryFullButton} onPress={close}>
            <Text style={styles.secondaryButtonText}>Fermer</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function StatBox({value, label, tone}) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, {color: tone}]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function TabButton({id, label, activeTab, setActiveTab}) {
  const active = activeTab === id;
  return (
    <Pressable style={[styles.tabButton, active && styles.tabButtonActive]} onPress={() => setActiveTab(id)}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
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
  safeArea: {flex: 1, backgroundColor: '#f4f7f5'},
  loadingScreen: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f4f7f5'},
  splashLogo: {width: 150, height: 150, borderRadius: 36, marginBottom: 18},
  loadingText: {color: '#64748b', marginTop: 12, fontSize: 15, fontWeight: '600'},
  accessScreen: {flex: 1, backgroundColor: '#f4f7f5', justifyContent: 'center', padding: 20},
  accessPanel: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 22,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  accessLogo: {width: 106, height: 106, borderRadius: 28, alignSelf: 'center', marginBottom: 16},
  accessTitle: {color: '#0f172a', fontSize: 26, fontWeight: '900', textAlign: 'center'},
  accessCopy: {color: '#64748b', fontSize: 14, lineHeight: 20, marginTop: 8, marginBottom: 18, textAlign: 'center'},
  appShell: {flex: 1, backgroundColor: '#f4f7f5'},
  header: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  headerLogo: {width: 48, height: 48, borderRadius: 14},
  brand: {color: '#0f172a', fontSize: 30, fontWeight: '900'},
  slogan: {color: '#64748b', fontSize: 13, marginTop: 1, fontWeight: '600'},
  addButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#0f766e',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f766e',
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 8},
  },
  addButtonText: {color: '#ffffff', fontSize: 28, lineHeight: 31, fontWeight: '700'},
  content: {flex: 1},
  screen: {flex: 1, paddingHorizontal: 16},
  heroPanel: {
    backgroundColor: '#0f172a',
    borderRadius: 24,
    padding: 20,
    marginBottom: 12,
  },
  heroKicker: {color: '#67e8f9', fontSize: 12, fontWeight: '900', textTransform: 'uppercase'},
  heroTitle: {color: '#ffffff', fontSize: 28, fontWeight: '900', marginTop: 8},
  heroCopy: {color: '#cbd5e1', fontSize: 14, marginTop: 8, fontWeight: '700'},
  statsRow: {flexDirection: 'row', gap: 8, marginBottom: 14},
  statBox: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  statValue: {fontSize: 26, fontWeight: '900'},
  statLabel: {color: '#64748b', fontSize: 12, marginTop: 3, fontWeight: '800'},
  sectionTitle: {color: '#0f172a', fontSize: 20, fontWeight: '900', marginBottom: 12},
  listContent: {paddingBottom: 24},
  deadlineCard: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    gap: 12,
  },
  statusRail: {width: 5, borderRadius: 999},
  deadlineMain: {flex: 1},
  cardTopline: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8},
  deadlineTitle: {color: '#0f172a', fontSize: 17, fontWeight: '900', flex: 1},
  deadlineDate: {color: '#334155', fontSize: 14, fontWeight: '800', marginTop: 8},
  deadlineMeta: {color: '#64748b', fontSize: 13, marginTop: 4, fontWeight: '600'},
  note: {color: '#475569', fontSize: 13, marginTop: 8, lineHeight: 18},
  statusPill: {borderRadius: 999, paddingHorizontal: 9, paddingVertical: 6},
  statusText: {fontSize: 11, fontWeight: '900'},
  formContent: {paddingBottom: 28},
  inputGroup: {marginBottom: 14},
  fieldLabel: {color: '#0f172a', fontSize: 14, fontWeight: '900', marginBottom: 8},
  input: {
    minHeight: 50,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#dbe4ef',
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '700',
  },
  textArea: {minHeight: 94, paddingTop: 12, textAlignVertical: 'top'},
  suggestionBlock: {marginBottom: 14},
  microLabel: {color: '#64748b', fontSize: 12, fontWeight: '900', marginBottom: 8, textTransform: 'uppercase'},
  chipGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {borderRadius: 999, backgroundColor: '#e6fffb', paddingHorizontal: 12, paddingVertical: 8},
  chipMuted: {borderRadius: 999, backgroundColor: '#f1f5f9', paddingHorizontal: 12, paddingVertical: 8},
  chipText: {color: '#0f766e', fontSize: 13, fontWeight: '900'},
  segmented: {flexDirection: 'row', backgroundColor: '#e2e8f0', borderRadius: 18, padding: 4, marginBottom: 16},
  segment: {flex: 1, borderRadius: 14, paddingVertical: 11, alignItems: 'center'},
  segmentActive: {backgroundColor: '#ffffff'},
  segmentText: {color: '#64748b', fontSize: 12, fontWeight: '900', textAlign: 'center'},
  segmentTextActive: {color: '#0f172a'},
  toggleRow: {
    minHeight: 56,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: {color: '#0f172a', fontSize: 15, fontWeight: '800'},
  primaryButton: {
    minHeight: 52,
    borderRadius: 18,
    backgroundColor: '#0f766e',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    marginTop: 18,
  },
  primaryButtonText: {color: '#ffffff', fontSize: 15, fontWeight: '900'},
  monthBlock: {marginBottom: 16},
  monthTitle: {color: '#64748b', fontSize: 14, fontWeight: '900', textTransform: 'capitalize', marginBottom: 8},
  softCard: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 15,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 10,
  },
  emptyText: {
    color: '#64748b',
    fontSize: 15,
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    fontWeight: '700',
  },
  settingsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    marginBottom: 12,
  },
  settingsTitle: {color: '#0f172a', fontSize: 16, fontWeight: '900'},
  settingsValue: {color: '#0f766e', fontSize: 32, fontWeight: '900', marginTop: 8},
  smallAction: {alignSelf: 'flex-start', marginTop: 14, backgroundColor: '#ecfeff', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8},
  smallActionText: {color: '#0e7490', fontSize: 13, fontWeight: '900'},
  toggleRowPlain: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14},
  stepperRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14},
  stepperControls: {flexDirection: 'row', alignItems: 'center', gap: 8},
  stepButton: {width: 34, height: 34, borderRadius: 12, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center'},
  stepButtonText: {color: '#0f172a', fontSize: 18, fontWeight: '900'},
  stepValue: {color: '#334155', fontSize: 13, fontWeight: '900', minWidth: 64, textAlign: 'center'},
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    paddingHorizontal: 7,
    paddingVertical: 8,
  },
  tabButton: {flex: 1, minHeight: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center'},
  tabButtonActive: {backgroundColor: '#ecfeff'},
  tabText: {color: '#64748b', fontSize: 11, fontWeight: '900'},
  tabTextActive: {color: '#0f766e'},
  modalBackdrop: {flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)', justifyContent: 'flex-end'},
  modalPanel: {backgroundColor: '#ffffff', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20},
  modalHandle: {width: 42, height: 5, borderRadius: 999, backgroundColor: '#cbd5e1', alignSelf: 'center', marginBottom: 16},
  modalTitle: {color: '#0f172a', fontSize: 25, fontWeight: '900'},
  modalStatus: {fontSize: 15, fontWeight: '900', marginTop: 8},
  modalDate: {color: '#0f172a', fontSize: 18, fontWeight: '900', marginTop: 12},
  modalNote: {color: '#475569', fontSize: 15, lineHeight: 21, marginTop: 12, marginBottom: 6},
  secondaryFullButton: {
    minHeight: 50,
    borderRadius: 18,
    backgroundColor: '#ecfeff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    marginTop: 10,
  },
  secondaryButtonText: {color: '#0f766e', fontSize: 14, fontWeight: '900'},
  dangerButton: {
    minHeight: 50,
    borderRadius: 18,
    backgroundColor: '#fff1f0',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    marginTop: 10,
  },
  dangerButtonText: {color: '#d92d20', fontSize: 14, fontWeight: '900'},
});
