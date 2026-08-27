import * as Notifications from 'expo-notifications';
import {Platform} from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function parseDueDate(value) {
  const [year, month, day] = value.split('-').map(Number);
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

function reminderTitle(daysBefore) {
  if (daysBefore === 0) {
    return 'Echeance aujourd\'hui';
  }
  if (daysBefore === 1) {
    return 'Echeance demain';
  }
  if (daysBefore === 7) {
    return 'Echeance dans 1 semaine';
  }
  if (daysBefore === 30) {
    return 'Echeance dans 1 mois';
  }
  return `Echeance dans ${daysBefore} jours`;
}

export async function configureNotifications() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('deadlines', {
      name: 'Echeances',
      importance: Notifications.AndroidImportance.HIGH,
      sound: true,
    });
  }
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

async function scheduleOne(id, title, body, date) {
  if (!date || date.getTime() <= Date.now()) {
    return;
  }
  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content: {
      title,
      body,
      sound: true,
      ...(Platform.OS === 'android' ? {channelId: 'deadlines'} : {}),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date,
    },
  });
}

export async function scheduleDeadlineNotifications(deadline) {
  await cancelDeadlineNotifications(deadline.id);

  const {id, title, dueDate, reminderOffsets, reminderHour, reminderMinute} = deadline;
  const idStr = String(id);
  const hour = reminderHour ?? 9;
  const minute = reminderMinute ?? 0;
  const offsets = Array.isArray(reminderOffsets) ? reminderOffsets : [];

  for (const daysBefore of offsets) {
    const date = reminderDate(dueDate, daysBefore, hour, minute);
    await scheduleOne(
      notificationId(idStr, daysBefore),
      reminderTitle(daysBefore),
      title,
      date,
    );
  }
}

export async function syncAllDeadlineNotifications(deadlines, enabled) {
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
    }
  }

  for (const notification of scheduled) {
    if (notification.identifier?.startsWith('deadline-') && !expectedIds.has(notification.identifier)) {
      await Notifications.cancelScheduledNotificationAsync(notification.identifier);
    }
  }

  for (const deadline of deadlines) {
    await scheduleDeadlineNotifications(deadline);
  }
}
