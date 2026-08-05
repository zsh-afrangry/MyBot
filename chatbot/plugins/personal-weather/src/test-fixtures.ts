/** Offline fixtures shaped after the current QWeather v1 and GeoAPI v2 docs. */

export const metadataFixture = {
  tag: "fixture-tag",
  attributions: ["https://developer.qweather.com/attribution.html"],
};

export const currentFixture = {
  metadata: metadataFixture,
  condition: { text: "多云", code: "101" },
  temperature: { value: 31.71, unit: "°C" },
  feelsLike: { value: 33.64, unit: "°C" },
  humidity: 0.69,
  wind: {
    direction: { degree: 226, compass: "sw" },
    speed: { value: 4.74, unit: "m/s" },
    scale: 3,
  },
  windGust: { value: 7.07, unit: "m/s" },
  precipitation: {
    amount: { value: 0, unit: "mm" },
    intensity: { value: 0, unit: "mm/h" },
    type: "none",
  },
  pressure: { value: 1001.5, unit: "hPa" },
  visibility: { value: 29_020, unit: "m" },
  dewPoint: { value: 25.36, unit: "°C" },
  cloudCover: 0.05,
  uvIndex: 0,
};

export const dailyFixture = {
  metadata: metadataFixture,
  days: [
    {
      forecastStartTime: "2026-08-06T00:00+08:00",
      forecastEndTime: "2026-08-07T00:00+08:00",
      temperatureMax: { value: 35.2, unit: "°C" },
      temperatureMin: { value: 27.1, unit: "°C" },
      temperatureAvg: { value: 30.4, unit: "°C" },
      uvIndexMax: 8,
      daytime: {
        forecastStartTime: "2026-08-06T07:00+08:00",
        forecastEndTime: "2026-08-06T19:00+08:00",
        condition: { text: "雷阵雨", code: "302" },
        precipitation: {
          amount: { value: 4.1, unit: "mm" },
          probability: 0.64,
          type: "rain",
        },
        humidity: 0.8,
      },
      nighttime: {
        forecastStartTime: "2026-08-06T19:00+08:00",
        forecastEndTime: "2026-08-07T07:00+08:00",
        condition: { text: "多云", code: "151" },
        precipitation: null,
      },
    },
  ],
};

export const hourlyFixture = {
  metadata: metadataFixture,
  hours: [
    {
      forecastTime: "2026-08-06T11:00+08:00",
      condition: { text: "雷阵雨", code: "302" },
      temperature: { value: 32.1, unit: "°C" },
      feelsLike: { value: 36.2, unit: "°C" },
      humidity: 0.76,
      wind: {
        direction: { degree: 215, compass: "sw" },
        speed: { value: 3.42, unit: "m/s" },
        scale: 3,
      },
      precipitation: {
        amount: { value: 0.09, unit: "mm" },
        intensity: { value: 0.09, unit: "mm/h" },
        probability: 0.64,
        type: "rain",
      },
      cloudCover: 0.92,
      uvIndex: 6,
    },
  ],
};

export const alertFixture = {
  metadata: {
    ...metadataFixture,
    zeroResult: false,
  },
  alerts: [
    {
      id: "alert-fixture-1",
      senderName: "天河区气象台",
      issuedTime: "2026-08-06T09:30+08:00",
      messageType: { code: "alert", supersedes: null },
      eventType: { name: "暴雨", code: "1003" },
      urgency: null,
      severity: "severe",
      certainty: null,
      icon: "1003",
      color: { code: "orange", red: 255, green: 165, blue: 0, alpha: 1 },
      effectiveTime: "2026-08-06T09:30+08:00",
      onsetTime: null,
      expireTime: "2026-08-06T15:30+08:00",
      headline: "暴雨橙色预警",
      description: "预计未来三小时有强降雨。",
      criteria: null,
      responseTypes: ["prepare"],
      instruction: "注意防范。",
    },
  ],
};

export const geoLookupFixture = {
  code: "200",
  location: [
    {
      name: "天河",
      id: "101280109",
      lat: "23.1356",
      lon: "113.3354",
      adm2: "广州市",
      adm1: "广东省",
      country: "中国",
      tz: "Asia/Shanghai",
      utcOffset: "+08:00",
      isDst: "0",
      type: "city",
      rank: "15",
      fxLink: "https://www.qweather.com/weather/tianhe-101280109.html",
    },
  ],
  refer: {
    sources: ["https://developer.qweather.com/attribution.html"],
    license: ["QWeather Developers License"],
  },
};
