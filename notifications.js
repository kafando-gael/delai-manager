import * as Notifications from 'expo-notifications';
import {Platform} from 'react-native';
import {translate} from './i18n';

const URGENT_SOUND = 'urgent.wav';
const CHANNEL_NORMAL = 'deadlines';
const CHANNEL_URGENT = 'deadlines-urgent';
const CATEGORY_NORMAL = 'deadline-normal';
const CATEGORY_URGENT = 'deadline-urgent';
const NUDGE_DELAYS_MS = [10 * 60 * 1000, 20 * 60 * 1000];

export const NOTIF_ACTIONS = {
  MARK_DONE: 'MARK_DONE',
  SNOOZE: 'SNOOZE',
  POSTPONE: 'POSTPONE',
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function parseDueDate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

function notificationId(deadlineId, daysBefore) {
  return `deadline-${deadlineId}-offset-${daysBefore}`;
}

function nudgeId(deadlineId, daysBefore, index) {
  return `deadline-${deadlineId}-offset-${daysBefore}-nudge-${index}`;
}

function reminderDate(dueDateStr, daysBefore, hour, minute) {
  const due = parseDueDate(dueDateStr);
  if (!due) {
    return null;
  }
  const date = new Date(due);
  date.setDate(date.getDate() - daysBefore);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function reminderTitle(daysBefore, language) {
  const t = (key, params) => translate(language, key, params);
  if (daysBefore === 0) {
    return t('notifToday');
  }
  if (daysBefore === 1) {
    return t('notifTomorrow');
  }
  if (daysBefore === 7) {
    return t('notifInWeek');
  }
  if (daysBefore === 30) {
    return t('notifInMonth');
  }
  return t('notifInDays', {count: daysBefore});
}

function isUrgentReminder(daysBefore, criticalDays, strongAlertsEnabled) {
  if (!strongAlertsEnabled) {
    return false;
  }
  return daysBefore <= (criticalDays ?? 3);
}

export function alertOptionsFromSettings(settings) {
  return {
    criticalDays: settings?.criticalDays ?? 3,
    strongAlertsEnabled: settings?.strongAlertsEnabled !== false,
    language: settings?.language === 'en' ? 'en' : 'fr',
  };
}

export async function configureNotifications(language = 'fr') {
  const t = (key) => translate(language, key);

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_NORMAL, {
      name: t('channelNormal'),
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
    await Notifications.setNotificationChannelAsync(CHANNEL_URGENT, {
      name: t('channelUrgent'),
      importance: Notifications.AndroidImportance.MAX,
      sound: 'urgent',
      vibrationPattern: [0, 250, 180, 250, 180, 250],
      enableVibrate: true,
    });
  }

  const actionOptions = {opensAppToForeground: false};
  const actions = [
    {identifier: NOTIF_ACTIONS.SNOOZE, buttonTitle: t('actionSnooze'), options: actionOptions},
    {identifier: NOTIF_ACTIONS.MARK_DONE, buttonTitle: t('actionDone'), options: actionOptions},
    {identifier: NOTIF_ACTIONS.POSTPONE, buttonTitle: t('actionPostpone'), options: actionOptions},
  ];
  await Notifications.setNotificationCategoryAsync(CATEGORY_URGENT, actions);
  await Notifications.setNotificationCategoryAsync(CATEGORY_NORMAL, [
    {identifier: NOTIF_ACTIONS.MARK_DONE, buttonTitle: t('actionDone'), options: actionOptions},
  ]);
}

export async function requestNotificationPermissions() {
  const settings = await Notifications.getPermissionsAsync();
  if (settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return true;
  }
  const result = await Notifications.requestPermissionsAsync();
  return result.granted || result.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

export async function cancelDeadlineNotifications(deadlineId) {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const prefix = `deadline-${deadlineId}-`;
  await Promise.all(
    scheduled
      .filter(notification => notification.identifier?.startsWith(prefix))
      .map(notification =>
        Notifications.cancelScheduledNotificationAsync(notification.identifier).catch(() => {}),
      ),
  );
}

async function scheduleOne({id, title, body, date, urgent, data}) {
  if (!date || date.getTime() <= Date.now()) {
    return;
  }
  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content: {
      title,
      body,
      sound: urgent ? URGENT_SOUND : true,
      categoryIdentifier: urgent ? CATEGORY_URGENT : CATEGORY_NORMAL,
      ...(Platform.OS === 'android'
        ? {channelId: urgent ? CHANNEL_URGENT : CHANNEL_NORMAL}
        : {}),
      data: data || {},
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date,
    },
  });
}

export async function scheduleDeadlineNotifications(deadline, alertOptions = {}) {
  await cancelDeadlineNotifications(deadline.id);

  const {id, title, dueDate, reminderOffsets, reminderHour, reminderMinute} = deadline;
  const idStr = String(id);
  const hour = reminderHour ?? 9;
  const minute = reminderMinute ?? 0;
  const offsets = Array.isArray(reminderOffsets) ? reminderOffsets : [];
  const language = alertOptions.language === 'en' ? 'en' : 'fr';
  const criticalDays = alertOptions.criticalDays ?? 3;
  const strongAlertsEnabled = alertOptions.strongAlertsEnabled !== false;

  for (const daysBefore of offsets) {
    const date = reminderDate(dueDate, daysBefore, hour, minute);
    const urgent = isUrgentReminder(daysBefore, criticalDays, strongAlertsEnabled);
    const heading = urgent
      ? translate(language, 'notifUrgentTitle')
      : reminderTitle(daysBefore, language);
    const data = {deadlineId: idStr, daysBefore, urgent: urgent ? 1 : 0};

    await scheduleOne({
      id: notificationId(idStr, daysBefore),
      title: heading,
      body: title,
      date,
      urgent,
      data,
    });

    if (!urgent || !date) {
      continue;
    }
    for (let index = 0; index < NUDGE_DELAYS_MS.length; index++) {
      const nudgeDate = new Date(date.getTime() + NUDGE_DELAYS_MS[index]);
      await scheduleOne({
        id: nudgeId(idStr, daysBefore, index + 1),
        title: translate(language, 'notifUrgentNudge'),
        body: title,
        date: nudgeDate,
        urgent: true,
        data,
      });
    }
  }
}

export async function snoozeDeadlineNotification(deadline, minutes = 10, alertOptions = {}) {
  if (!deadline?.id) {
    return;
  }
  const language = alertOptions.language === 'en' ? 'en' : 'fr';
  const date = new Date(Date.now() + minutes * 60 * 1000);
  await scheduleOne({
    id: `deadline-${deadline.id}-snooze-${Date.now()}`,
    title: translate(language, 'notifUrgentNudge'),
    body: deadline.title,
    date,
    urgent: true,
    data: {deadlineId: String(deadline.id), urgent: 1, snooze: 1},
  });
}

export async function syncAllDeadlineNotifications(deadlines, enabled, alertOptions = {}) {
  if (!enabled) {
    await Notifications.cancelAllScheduledNotificationsAsync();
    return;
  }

  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const expectedIds = new Set();
  for (const deadline of deadlines) {
    const offsets = Array.isArray(deadline.reminderOffsets) ? deadline.reminderOffsets : [];
    for (const daysBefore of offsets) {
      expectedIds.add(notificationId(deadline.id, daysBefore));
      const urgent = isUrgentReminder(
        daysBefore,
        alertOptions.criticalDays ?? 3,
        alertOptions.strongAlertsEnabled !== false,
      );
      if (urgent) {
        expectedIds.add(nudgeId(deadline.id, daysBefore, 1));
        expectedIds.add(nudgeId(deadline.id, daysBefore, 2));
      }
    }
  }

  for (const notification of scheduled) {
    const id = notification.identifier || '';
    if (id.startsWith('deadline-') && !id.includes('-snooze-') && !expectedIds.has(id)) {
      await Notifications.cancelScheduledNotificationAsync(id);
    }
  }

  for (const deadline of deadlines) {
    await scheduleDeadlineNotifications(deadline, alertOptions);
  }
}

export function subscribeNotificationActions(onAction) {
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    const action = response.actionIdentifier;
    if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) {
      return;
    }
    const data = response.notification.request.content.data || {};
    onAction(action, data);
  });
  return () => sub.remove();
}
