/**
 * Fixture data for mapObsToConditions tests.
 * Simulates the raw SMHI metobs API response structure.
 * Each entry: date is epoch ms, value is a string numeric.
 */

export const tempObsFixture = {
  stationId: "98210",
  parameter: "temp",
  value: [
    { date: 1718445600000, value: "14.7" }, // 2024-06-15T10:00:00Z
    { date: 1718449200000, value: "15.3" }, // 2024-06-15T11:00:00Z
    { date: 1718452800000, value: "16.1" }, // 2024-06-15T12:00:00Z
  ],
};

export const pressureObsFixture = {
  stationId: "98210",
  parameter: "pressure",
  value: [
    { date: 1718445600000, value: "1013.2" },
    { date: 1718449200000, value: "1012.8" },
    { date: 1718452800000, value: "1012.0" },
  ],
};

export const windSpeedObsFixture = {
  stationId: "98210",
  parameter: "wind_speed",
  value: [
    { date: 1718445600000, value: "3.2" },
    { date: 1718449200000, value: "4.5" },
    { date: 1718452800000, value: "4.1" },
  ],
};

export const windDirObsFixture = {
  stationId: "98210",
  parameter: "wind_from_direction",
  value: [
    { date: 1718445600000, value: "270" },
    { date: 1718449200000, value: "265" },
    { date: 1718452800000, value: "260" },
  ],
};
