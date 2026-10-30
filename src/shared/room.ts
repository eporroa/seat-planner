// Single demo room. The server reads DEMO_ROOM_ID and must match this value.
export const DEMO_ROOM_ID = "jsconf-mx-2026";

export const ROOM_WIDTH = 1600;
export const ROOM_HEIGHT = 1000;
export const MAX_TABLES = 60;

export const SEAT_LIMIT_MIN = 1;
export const SEAT_LIMIT_MAX = 12;
export const RADIUS_MIN = 40;
export const RADIUS_MAX = 100;
export const RECT_SIZE_MIN = 80;
export const RECT_SIZE_MAX = 320;
export const LABEL_MAX = 20;

// Chairs one attendee can hold at once. Past this the oldest is released
// automatically; admins have no limit. The SQL on both sides repeats the number.
export const MAX_SEATS_PER_ATTENDEE = 20;
