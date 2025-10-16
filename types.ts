export enum Page {
  Main = 'main',
  Employees = 'employees',
  Reports = 'reports',
  MyReports = 'my-reports',
  Admin = 'admin',
}

export enum SyncStatus {
  Connecting = 'connecting',
  Connected = 'connected',
  Syncing = 'syncing',
  Error = 'error',
  Offline = 'offline',
}

export type ActionType = 'checkin' | 'checkout' | 'employee_added' | 'admin_password_change' | 'employee_removed';

export interface AttendanceLog {
  employee: string;
  action: ActionType;
  timestamp: string; // ISO format
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  source: string;
}

export interface DailyLog {
  action: 'checkin' | 'checkout';
  timestamp: string;
}

export interface ShiftPair {
  checkin: string;
  checkout: string;
  duration: number; // in hours
}

export interface DailySummary {
  date: string;
  firstIn: string | null;
  lastOut: string | null;
  totalHours: number;
  shiftPairs: ShiftPair[];
  logs: DailyLog[];
}

export type AttendanceData = Map<string, Map<string, DailySummary>>;