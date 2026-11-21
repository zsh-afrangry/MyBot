const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const clock = /^\d{4}-\d\d-\d\d[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:[0-5]\d)?$/u;

export function dailyFeedbackQuery({broadcast, scheduledAt, cronJobId}) {
  if (!['reminder-list', 'weather'].includes(broadcast) || typeof scheduledAt !== 'string' || !clock.test(scheduledAt)
    || (cronJobId !== undefined && (typeof cronJobId !== 'string' || !uuid.test(cronJobId)))) throw Error('Invalid daily feedback query');
  const time = scheduledAt.replace(' ', 'T');
  const date = new Date(time.slice(0, 10) + 'T00:00Z');
  const at = Date.parse(/Z$|[+-]\d\d:\d\d$/u.test(time) ? time : time + '+08:00');
  if (!Number.isFinite(at) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== time.slice(0, 10)
    || (broadcast === 'reminder-list' && at % 60000 !== 0)) throw Error('Invalid scheduled time');
  return {broadcast, at, cronJobId};
}
