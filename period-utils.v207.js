(() => {
  "use strict";

  const BUILD = "2.0.7-rc5-fast-load-20260804";
  const MOSCOW_TIME_ZONE = "Europe/Moscow";
  const SWITCH_HOUR = 23;
  const SWITCH_MINUTE = 30;

  function parts(date = new Date()) {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: MOSCOW_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }).formatToParts(date)
        .filter(part => part.type !== "literal")
        .map(part => [part.type, Number(part.value)])
    );
    return values;
  }

  function isoDate(year, month, day) {
    return [
      String(year).padStart(4, "0"),
      String(month).padStart(2, "0"),
      String(day).padStart(2, "0")
    ].join("-");
  }

  function shiftIso(iso, days) {
    const [year, month, day] = iso.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days, 12));
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  function weekday(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  }

  function reportPeriodRangeAt(date = new Date()) {
    const current = parts(date);
    const today = isoDate(current.year, current.month, current.day);
    const day = weekday(current.year, current.month, current.day);
    let daysSinceWednesday = (day - 3 + 7) % 7;
    const beforeSwitch = current.hour < SWITCH_HOUR ||
      (current.hour === SWITCH_HOUR && current.minute < SWITCH_MINUTE);
    if (day === 3 && beforeSwitch) daysSinceWednesday = 7;
    const start = shiftIso(today, -daysSinceWednesday);
    return [start, shiftIso(start, 7)];
  }

  function nextSwitchAt(date = new Date()) {
    const current = parts(date);
    const today = isoDate(current.year, current.month, current.day);
    const day = weekday(current.year, current.month, current.day);
    const minutes = current.hour * 60 + current.minute;
    const switchMinutes = SWITCH_HOUR * 60 + SWITCH_MINUTE;
    let daysUntilWednesday = (3 - day + 7) % 7;
    if (daysUntilWednesday === 0 && minutes >= switchMinutes) daysUntilWednesday = 7;
    const switchDate = shiftIso(today, daysUntilWednesday);
    const [year, month, dayOfMonth] = switchDate.split("-").map(Number);
    // Москва не использует сезонный перевод часов: 23:30 МСК = 20:30 UTC.
    return new Date(Date.UTC(year, month - 1, dayOfMonth, 20, 30, 0));
  }

  window.PhotoDashboardPeriod = Object.freeze({
    reportPeriodRangeAt,
    nextSwitchAt,
    timeZone: MOSCOW_TIME_ZONE,
    switchTime: "23:30"
  });
  window.PHOTO_DASHBOARD_ASSETS ||= Object.create(null);
  window.PHOTO_DASHBOARD_ASSETS.period = BUILD;
})();
