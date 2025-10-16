import type { DailyLog } from '../types';

// Hardcode API Key to resolve environment variable issues in the browser.
// This key was present in the original version of the application.
const API_KEY = 'AIzaSyB8MgwEZ7hqS_hiZqTcwzODheuwdBA55j4';
const SHEET_ID = '1SNSdRdJy-vP--spyKmVwDbnaz808KEwTYSKiLreFn0w';
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx_UMxeN_-dYeiR4xQa4HzT9ogZPv8BeYkRuUg0BOeEobOQZJVvj7gZU-2U_5LrxEtK/exec';

export type RawLogData = Map<string, Map<string, DailyLog[]>>;

export const fetchAndProcessData = async (): Promise<{
  rawLogData: RawLogData,
  employees: string[],
  adminPassword: string
}> => {
  if (!API_KEY) {
    throw new Error('API key is not available.');
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/גיליון1!A:F?key=${API_KEY}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const data = await response.json();
  const rows: any[][] = data.values || [];

  const employeeSet = new Set<string>();
  const removedEmployeeSet = new Set<string>();
  let adminPassword = '1234';
  const rawLogData: RawLogData = new Map();

  for (let i = 1; i < rows.length; i++) {
    try {
      const row = rows[i];
      // Add a guard to prevent crashing on empty/malformed rows
      if (!Array.isArray(row) || row.length === 0) continue;

      const [employee, action, timestamp, date, time, source] = row;

      if (!action) continue;
      
      // Process actions in a structured way
      switch (action) {
          case 'employee_added':
              if (employee) {
                employeeSet.add(employee);
                removedEmployeeSet.delete(employee);
              }
              continue; 

          case 'employee_removed':
              if (employee) {
                removedEmployeeSet.add(employee);
              }
              continue;

          case 'admin_password_change':
              if (employee) adminPassword = employee;
              continue;
          
          case 'checkin':
          case 'checkout':
              // CRITICAL FIX: Ensure employee name exists for attendance logs.
              if (!employee || !timestamp || !date) continue;
              
              // Validate that the timestamp is a valid date to prevent crashes
              const d = new Date(timestamp);
              if (isNaN(d.getTime())) {
                  console.warn(`Invalid timestamp found for ${employee} on ${date}: "${timestamp}". Skipping this log.`);
                  continue; 
              }
              
              // Always add the employee to the main set from any valid activity
              employeeSet.add(employee);
              
              if (!rawLogData.has(employee)) {
                  rawLogData.set(employee, new Map());
              }
              const employeeData = rawLogData.get(employee)!;

              if (!employeeData.has(date)) {
                  employeeData.set(date, []);
              }
              const dateLogs = employeeData.get(date)!;
              dateLogs.push({ action, timestamp });
              break;
              
          default:
              // For any other unknown action, still try to register the employee name
              // This ensures employees from old log formats are still included.
              if(employee) employeeSet.add(employee);
              break;
      }
    } catch (e) {
      console.error(`Error processing row ${i + 1}:`, rows[i], e);
      // Continue to the next row instead of crashing
      continue;
    }
  }

  // Sort logs within each day for correct calculations
  for (const employeeData of rawLogData.values()) {
      for (const logs of employeeData.values()) {
          logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      }
  }

  // Finalize the employee list
  const employees = Array.from(employeeSet)
    .filter(emp => !removedEmployeeSet.has(emp) && emp !== 'SYSTEM')
    .sort((a, b) => a.localeCompare(b, 'he'));

  return { rawLogData, employees, adminPassword };
};


export const recordToSheet = async (employee: string, action: string, timestamp: string, date: string, time: string): Promise<boolean> => {
    try {
        const source = 'PWA';
        const rowData = [employee, action, timestamp, date, time, source];

        const response = await fetch(SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ values: [rowData] }),
            redirect: 'follow'
        });

        if (!response.ok) {
            console.error('Google Script returned a network error:', response.status, response.statusText);
            return false;
        }
        
        const result = await response.json();

        // The script returns {ok: true} on success and {ok: false, error: ...} on failure,
        // even with a 200 OK status. We must check the body.
        if (result && result.ok === true) {
            return true;
        } else {
            // Log the specific error message from the script for better debugging.
            console.error('Google Script returned a logical error:', result.error || 'Unknown error');
            return false;
        }

    } catch (error) {
        console.error('Error recording to sheet (fetch failed):', error);
        return false;
    }
};