import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Page, SyncStatus, AttendanceData, DailySummary, DailyLog, ActionType, ShiftPair } from './types';
import { fetchAndProcessData, recordToSheet, RawLogData } from './services/googleSheetsService';

// Helper to format time from ISO string
const formatTime = (isoString: string | null | undefined): string => {
  if (!isoString) return '-';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '-';
  }
};

const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS' }).format(amount);
};

type CalculationMethod = 'firstLast' | 'pairs';
type ReportViewType = 'day' | 'week' | 'month';

const getWeekRange = (date: Date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0); 
    const day = d.getDay(); // Sunday - 0
    const diff = d.getDate() - day;
    const startOfWeek = new Date(d.setDate(diff));
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    return { startOfWeek, endOfWeek };
};

const App: React.FC = () => {
  // --- STATE MANAGEMENT ---
  const [page, setPage] = useState<Page>(Page.Main);
  const [rawLogData, setRawLogData] = useState<RawLogData>(new Map());
  const [attendanceData, setAttendanceData] = useState<AttendanceData>(new Map());
  const [employees, setEmployees] = useState<string[]>([]);
  const [adminPassword, setAdminPassword] = useState<string>('1234');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(SyncStatus.Connecting);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [currentUser, setCurrentUser] = useState<{ name: string; isAdmin: boolean } | null>(null);
  
  // UI State
  const [alert, setAlert] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const isUpdating = useRef(false); // Using ref to avoid stale state in callbacks
  
  // Page-specific State
  const [reportsSelectedEmployee, setReportsSelectedEmployee] = useState<string>('');
  const [reportDate, setReportDate] = useState(new Date());
  const [calculationMethod, setCalculationMethod] = useState<CalculationMethod>('firstLast');
  const [reportViewType, setReportViewType] = useState<ReportViewType>('month');
  const [newEmployeeName, setNewEmployeeName] = useState('');
  const [removeEmployeeSelect, setRemoveEmployeeSelect] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [identifySelect, setIdentifySelect] = useState('');
  const [loginPasswordInput, setLoginPasswordInput] = useState('');

  const [employeeWages, setEmployeeWages] = useState<Record<string, number>>({});
  const [tempWages, setTempWages] = useState<Record<string, string>>({});

  // Admin retroactive entry state
  const [retroEmployee, setRetroEmployee] = useState('');
  const [retroDate, setRetroDate] = useState(new Date().toISOString().split('T')[0]);
  const [retroCheckinTime, setRetroCheckinTime] = useState('');
  const [retroCheckoutTime, setRetroCheckoutTime] = useState('');


  // --- DATA FETCHING & SYNC ---

  const showAlert = useCallback((message: string, type: 'success' | 'error') => {
    setAlert({ message, type });
    setTimeout(() => setAlert(null), 4000);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('currentUser');
    setCurrentUser(null);
    setPage(Page.Main); // Reset page to default on logout
    showAlert('התנתקת בהצלחה.', 'success');
  }, [showAlert]);


  const backgroundSync = useCallback(async () => {
      if (isUpdating.current) return; // Prevent sync during critical updates
      setSyncStatus(SyncStatus.Syncing);
      try {
        const { rawLogData: data, employees: empList, adminPassword: pw } = await fetchAndProcessData();
        setRawLogData(data);
        setEmployees(empList);
        setAdminPassword(pw);
        setSyncStatus(SyncStatus.Connected);
      } catch (err) {
        console.error(err);
        setSyncStatus(SyncStatus.Error);
      }
  }, []);
  
  const loadData = useCallback(async () => {
    setSyncStatus(SyncStatus.Connecting);
    
    try {
      const { rawLogData: data, employees: empList, adminPassword: pw } = await fetchAndProcessData();
      setRawLogData(data);
      setEmployees(empList);
      setAdminPassword(pw);
      setSyncStatus(SyncStatus.Connected);
      return empList; // Return the new list for checks
    } catch (err) {
      console.error(err);
      setSyncStatus(SyncStatus.Error);
      showAlert('שגיאה בסנכרון הנתונים', 'error');
      return []; // Return empty on error
    }
  }, [showAlert]);
  
  // Load device identity & wages on initial start
  useEffect(() => {
    try {
        const savedUser = localStorage.getItem('currentUser');
        if (savedUser) {
            setCurrentUser(JSON.parse(savedUser));
        }
    } catch {
        localStorage.removeItem('currentUser');
    }
    
    try {
        const savedWages = localStorage.getItem('employeeWages');
        if (savedWages) {
            const parsedWages = JSON.parse(savedWages);
            // FIX: Add robust validation for parsed wages from localStorage to prevent type errors.
            // This ensures that we only process valid objects and that values are correctly handled,
            // preventing crashes or downstream errors if the stored data is corrupted or in an unexpected format.
            if (typeof parsedWages === 'object' && parsedWages !== null && !Array.isArray(parsedWages)) {
                const validatedWages: Record<string, number> = {};
                const stringWages: Record<string, string> = {};
                for (const [key, value] of Object.entries(parsedWages)) {
                    if (value !== null && typeof value !== 'undefined') {
                        const numValue = Number(value);
                        if (!isNaN(numValue)) {
                            validatedWages[key] = numValue;
                            stringWages[key] = String(value);
                        }
                    }
                }
                setEmployeeWages(validatedWages);
                setTempWages(stringWages);
            }
        }
    } catch (e) {
        console.error("Failed to load or parse employee wages from localStorage", e);
    }
  }, []);

  // Initial load and intervals
  useEffect(() => {
    loadData();
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    const syncInterval = setInterval(() => backgroundSync(), 120000);
    return () => {
        clearInterval(timer);
        clearInterval(syncInterval);
    };
  }, [loadData, backgroundSync]);

  // Effect to check if the identified employee still exists
  useEffect(() => {
    if (currentUser && !currentUser.isAdmin && employees.length > 0 && !employees.includes(currentUser.name)) {
      showAlert(`העובד "${currentUser.name}" הוסר מהמערכת.`, 'error');
      handleLogout();
    }
  }, [currentUser, employees, showAlert, handleLogout]);

  // Page access control
  useEffect(() => {
      if (currentUser) {
        if (currentUser.isAdmin) {
          // Admin cannot access "MyReports"
          if (page === Page.MyReports) setPage(Page.Employees);
        } else {
          // Employee can only access Main and MyReports
          const allowedPages = [Page.Main, Page.MyReports];
          if (!allowedPages.includes(page)) {
            setPage(Page.Main);
          }
        }
      }
    }, [page, currentUser]);
  
  // Set default employee selections for dropdowns when employee list changes
  useEffect(() => {
      if (employees.length > 0) {
          const defaultEmployee = employees[0];
          const setDefault = (current: string) => (!current || !employees.includes(current)) ? defaultEmployee : current;
          
          setReportsSelectedEmployee(current => setDefault(current));
          setRemoveEmployeeSelect(current => setDefault(current));
          setRetroEmployee(current => setDefault(current));
      } else {
         setReportsSelectedEmployee('');
         setRemoveEmployeeSelect('');
         setRetroEmployee('');
      }
  }, [employees]);
  
  
  // --- DATA PROCESSING ---
  const calculateHoursAndPairs = useCallback((logs: DailyLog[]): { totalHours: number, pairs: ShiftPair[] } => {
    const checkins = logs.filter(l => l.action === 'checkin').map(l => new Date(l.timestamp));
    const checkouts = logs.filter(l => l.action === 'checkout').map(l => new Date(l.timestamp));
    
    if (checkins.length === 0 || checkouts.length === 0) return { totalHours: 0, pairs: [] };
    
    const sortedLogs = [...logs]
      .filter(l => l.action === 'checkin' || l.action === 'checkout')
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        
    let totalMs = 0;
    let pairs: ShiftPair[] = [];
    let lastCheckinTime: Date | null = null;
    
    for (const log of sortedLogs) {
        const timestamp = new Date(log.timestamp);
        if (log.action === 'checkin') {
            if (lastCheckinTime === null) {
                lastCheckinTime = timestamp;
            }
        } else if (log.action === 'checkout' && lastCheckinTime !== null) {
            const durationMs = timestamp.getTime() - lastCheckinTime.getTime();
            if(durationMs > 0) {
              totalMs += durationMs;
              pairs.push({
                  checkin: lastCheckinTime.toISOString(),
                  checkout: timestamp.toISOString(),
                  duration: durationMs / (1000 * 60 * 60)
              });
            }
            lastCheckinTime = null;
        }
    }
    return { totalHours: totalMs / (1000 * 60 * 60), pairs: pairs };
  }, []);

  useEffect(() => {
    try {
      const newAttendanceData: AttendanceData = new Map();
      for (const [employee, dates] of rawLogData.entries()) {
          const employeeDates = new Map<string, DailySummary>();
          for (const [date, logs] of dates.entries()) {
              const checkins = logs.filter(log => log.action === 'checkin');
              const checkouts = logs.filter(log => log.action === 'checkout');

              const firstIn = checkins.length > 0 ? checkins[0].timestamp : null;
              const lastOut = checkouts.length > 0 ? checkouts[checkouts.length - 1].timestamp : null;
              
              const { totalHours, pairs } = calculateHoursAndPairs(logs);
              
              const totalHoursFirstLast = () => {
                   if (!firstIn || !lastOut) return 0;
                   const firstInMs = new Date(firstIn).getTime();
                   const lastOutMs = new Date(lastOut).getTime();
                   return lastOutMs > firstInMs ? (lastOutMs - firstInMs) / (1000 * 60 * 60) : 0;
              }

              employeeDates.set(date, {
                  date,
                  firstIn,
                  lastOut,
                  totalHours: calculationMethod === 'firstLast' ? totalHoursFirstLast() : totalHours,
                  shiftPairs: pairs,
                  logs,
              });
          }
          newAttendanceData.set(employee, employeeDates);
      }
      setAttendanceData(newAttendanceData);
    } catch (error) {
        console.error("Error during attendance data processing:", error);
        showAlert('שגיאה קריטית בעיבוד הנתונים', 'error');
        setSyncStatus(SyncStatus.Error);
    }
  }, [rawLogData, calculationMethod, calculateHoursAndPairs, showAlert]);


    // --- REPORT DATA CALCULATION (MEMOIZED) ---
    const reportDataForSelectedEmployee = useMemo(() => {
        const employeeData = attendanceData.get(reportsSelectedEmployee);
        if (!employeeData) return [];
        
        const daysInRange: DailySummary[] = [];

        if (reportViewType === 'month') {
            const year = reportDate.getFullYear();
            const month = reportDate.getMonth();
            for (const [date, summary] of employeeData.entries()) {
                const d = new Date(date);
                if (d.getFullYear() === year && d.getMonth() === month) {
                    daysInRange.push(summary);
                }
            }
        } else if (reportViewType === 'week') {
            const { startOfWeek, endOfWeek } = getWeekRange(reportDate);
            endOfWeek.setHours(23, 59, 59, 999);
            for (const [date, summary] of employeeData.entries()) {
                const d = new Date(date);
                if (d >= startOfWeek && d <= endOfWeek) {
                    daysInRange.push(summary);
                }
            }
        } else { // day
            const selectedDateStr = reportDate.toISOString().split('T')[0];
            const summary = employeeData.get(selectedDateStr);
            if (summary) {
                daysInRange.push(summary);
            }
        }
        
        return daysInRange.sort((a,b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }, [attendanceData, reportsSelectedEmployee, reportViewType, reportDate]);

    const reportDataForCurrentUser = useMemo(() => {
        if (!currentUser) return [];
        const employeeData = attendanceData.get(currentUser.name);
        if (!employeeData) return [];
        
        const daysInRange: DailySummary[] = [];

        if (reportViewType === 'month') {
            const year = reportDate.getFullYear();
            const month = reportDate.getMonth();
            for (const [date, summary] of employeeData.entries()) {
                const d = new Date(date);
                if (d.getFullYear() === year && d.getMonth() === month) {
                    daysInRange.push(summary);
                }
            }
        } else if (reportViewType === 'week') {
            const { startOfWeek, endOfWeek } = getWeekRange(reportDate);
             endOfWeek.setHours(23, 59, 59, 999);
            for (const [date, summary] of employeeData.entries()) {
                const d = new Date(date);
                if (d >= startOfWeek && d <= endOfWeek) {
                    daysInRange.push(summary);
                }
            }
        } else { // day
            const selectedDateStr = reportDate.toISOString().split('T')[0];
            const summary = employeeData.get(selectedDateStr);
            if (summary) {
                daysInRange.push(summary);
            }
        }
        
        return daysInRange.sort((a,b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }, [attendanceData, currentUser, reportViewType, reportDate]);


  // --- ACTIONS ---

  const handleAction = async (
    action: ActionType, 
    employeeName: string, 
    details: { payload?: string; timestamp?: string } = {}
  ) => {
    const eventDate = details.timestamp ? new Date(details.timestamp) : new Date();
    const timestamp = eventDate.toISOString();
    const date = eventDate.toISOString().split('T')[0];
    const time = eventDate.toLocaleTimeString('he-IL', { hour12: false });
    
    let recordEmployee = employeeName;
    if (action === 'admin_password_change' && details.payload) {
        recordEmployee = details.payload;
    }

    setSyncStatus(SyncStatus.Syncing);
    const success = await recordToSheet(recordEmployee, action, timestamp, date, time);

    if (success) {
      setSyncStatus(SyncStatus.Connected);
    } else {
      setSyncStatus(SyncStatus.Error);
      showAlert('הרישום נכשל. בדוק חיבור לאינטרנט.', 'error');
    }
    return success;
  };
  
  const handleCheckIn = () => {
    if (!currentUser || currentUser.isAdmin) return;
    handleAction('checkin', currentUser.name).then(s => s && showAlert(`${currentUser.name} נרשם לכניסה`, 'success'));
  };
  const handleCheckOut = () => {
    if (!currentUser || currentUser.isAdmin) return;
    handleAction('checkout', currentUser.name).then(s => s && showAlert(`${currentUser.name} נרשם ליציאה`, 'success'));
  };

  const handleQuickAction = async (action: 'checkin' | 'checkout', employeeName: string) => {
    const success = await handleAction(action, employeeName);
    if (success) {
      const actionText = action === 'checkin' ? 'נרשם לכניסה' : 'נרשם ליציאה';
      showAlert(`${employeeName} ${actionText}`, 'success');
      await backgroundSync();
    }
  };

  const handleAddEmployee = async () => {
    const trimmedName = newEmployeeName.trim();
    if (!trimmedName) {
        showAlert('אנא הזן שם עובד', 'error');
        return;
    }
    if (employees.includes(trimmedName)) {
        showAlert('עובד בשם זה כבר קיים', 'error');
        return;
    }
    
    const originalEmployees = [...employees];
    const newEmployeeList = [...employees, trimmedName].sort((a, b) => a.localeCompare(b, 'he'));

    setEmployees(newEmployeeList);
    showAlert(`העובד ${trimmedName} נוסף! מסנכרן ברקע...`, 'success');
    setNewEmployeeName('');
    isUpdating.current = true;

    try {
        const success = await handleAction('employee_added', trimmedName);
        if (!success) {
            showAlert(`הוספת העובד ${trimmedName} נכשלה.`, 'error');
            setEmployees(originalEmployees);
        }
    } catch (error) {
        console.error("Critical error during employee addition:", error);
        showAlert(`שגיאה קריטית. החזרת הרשימה לקדמותה.`, 'error');
        setEmployees(originalEmployees);
    } finally {
        isUpdating.current = false;
    }
  };
  
  const handleAddRetroShift = async () => {
      if (!retroEmployee || !retroDate || !retroCheckinTime || !retroCheckoutTime) {
          showAlert('נא למלא את כל השדות', 'error');
          return;
      }
      const checkinTimestamp = new Date(`${retroDate}T${retroCheckinTime}`).toISOString();
      const checkoutTimestamp = new Date(`${retroDate}T${retroCheckoutTime}`).toISOString();
      
      if (new Date(checkoutTimestamp) <= new Date(checkinTimestamp)) {
          showAlert('זמן יציאה חייב להיות אחרי זמן כניסה', 'error');
          return;
      }

      showAlert('רושם כניסה...', 'success');
      const successIn = await handleAction('checkin', retroEmployee, { timestamp: checkinTimestamp });
      if (successIn) {
          showAlert('רושם יציאה...', 'success');
          setTimeout(async () => {
            await handleAction('checkout', retroEmployee, { timestamp: checkoutTimestamp });
            showAlert('משמרת רטרואקטיבית נוספה בהצלחה', 'success');
            await backgroundSync();
            setRetroCheckinTime('');
            setRetroCheckoutTime('');
          }, 1000);
      }
  };
  
  const handleRemoveEmployee = async () => {
    const employeeToRemove = removeEmployeeSelect;
    if (!employeeToRemove) {
      showAlert('אנא בחר עובד להסרה', 'error');
      return;
    }

    const originalEmployees = [...employees];
    const newEmployeeList = employees.filter(e => e !== employeeToRemove);
    
    setEmployees(newEmployeeList);
    showAlert(`העובד ${employeeToRemove} הוסר בהצלחה!`, 'success');
    
    if (newEmployeeList.length > 0) {
      setRemoveEmployeeSelect(newEmployeeList[0]);
    } else {
      setRemoveEmployeeSelect('');
    }

    isUpdating.current = true;

    try {
      const success = await handleAction('employee_removed', employeeToRemove);
      if (!success) {
        showAlert(`שגיאת סנכרון. החזרת ${employeeToRemove} לרשימה.`, 'error');
        setEmployees(originalEmployees);
      } 
    } catch (error) {
        console.error("Critical error during employee removal:", error);
        showAlert(`שגיאה קריטית. החזרת ${employeeToRemove} לרשימה.`, 'error');
        setEmployees(originalEmployees);
    } finally {
        isUpdating.current = false;
    }
  };

  const handleCancelShift = async (pair: ShiftPair) => {
    if (!window.confirm(`האם לבטל את המשמרת מ-${formatTime(pair.checkin)} עד ${formatTime(pair.checkout)}?`)) {
      return;
    }
    // FIX: Argument of type 'unknown' is not assignable to parameter of type 'string'.
    const success = await handleAction('checkout', reportsSelectedEmployee, { timestamp: String(pair.checkin) });
    if (success) {
      showAlert('המשמרת בוטלה בהצלחה.', 'success');
      await backgroundSync();
    }
  };


  const handleChangeAdminPassword = async () => {
    if (!newAdminPassword || newAdminPassword.length < 4) {
      showAlert('הסיסמה חייבת להכיל לפחות 4 תווים', 'error');
      return;
    }
    const success = await handleAction('admin_password_change', 'admin', { payload: newAdminPassword });
    if (success) {
      showAlert('סיסמת המנהל שונתה בהצלחה', 'success');
      setNewAdminPassword('');
    }
  };

  const handleLogin = () => {
    if (!identifySelect) return;
    
    if (identifySelect === 'admin') {
        if (loginPasswordInput === adminPassword) {
            const adminUser = { name: 'מנהל', isAdmin: true };
            localStorage.setItem('currentUser', JSON.stringify(adminUser));
            setCurrentUser(adminUser);
            setPage(Page.Employees); // A better start page for admin
            showAlert('נכנסת בהצלחה למצב ניהול', 'success');
        } else {
            showAlert('קוד גישה שגוי', 'error');
        }
    } else {
        const employeeUser = { name: identifySelect, isAdmin: false };
        localStorage.setItem('currentUser', JSON.stringify(employeeUser));
        setCurrentUser(employeeUser);
        setPage(Page.Main);
        showAlert(`שלום, ${identifySelect}!`, 'success');
    }
  };
  
  const handleWageChange = (employee: string, value: string) => {
    const sanitizedValue = value.replace(/[^0-9.]/g, '');
    setTempWages(prev => ({ ...prev, [employee]: sanitizedValue }));
  };

  const handleSaveWages = () => {
      try {
          const newWages: Record<string, number> = {};
          for (const [employee, value] of Object.entries(tempWages)) {
              const numValue = parseFloat(value);
              if (!isNaN(numValue) && numValue >= 0) {
                  newWages[employee] = numValue;
              }
          }
          setEmployeeWages(newWages);
          localStorage.setItem('employeeWages', JSON.stringify(newWages));
          showAlert('שכר העובדים עודכן בהצלחה', 'success');
      } catch (e) {
          console.error("Failed to save wages to localStorage", e);
          showAlert('שגיאה בשמירת נתוני השכר', 'error');
      }
  };

  const handleExportCurrentReportToCsv = (reportData: DailySummary[], employeeName: string, reportTitle: string) => {
    if (!employeeName || reportData.length === 0) {
      showAlert('אין נתונים לייצוא.', 'error');
      return;
    }

    // --- Build CSV content ---
    const totalHours = reportData.reduce((sum, day) => sum + day.totalHours, 0);
    const wage = employeeWages[employeeName] || 0;
    const estimatedSalary = totalHours * wage;
    const calculationMethodText = calculationMethod === 'firstLast' ? 'כניסה-יציאה' : 'זוגות';

    const summaryRows: string[][] = [
        ['דוח נוכחות'],
        [''],
        ['שם עובד:', employeeName],
        ['תקופת הדוח:', reportTitle],
        ['שיטת חישוב:', calculationMethodText],
        [''],
        ['סה"כ ימי עבודה:', String(reportData.length)],
        ['סה"כ שעות עבודה:', totalHours.toFixed(3)],
        ['שכר לשעה:', wage > 0 ? formatCurrency(wage) : 'לא הוגדר'],
        ['שכר מוערך לתקופה:', formatCurrency(estimatedSalary)],
        [''],
        ['--- פירוט יומי ---'],
        [''],
    ];

    const headers = ['תאריך', 'כניסה', 'יציאה', 'שעות'];
    const dataRows: string[][] = [];

    if (calculationMethod === 'firstLast') {
        reportData.forEach(day => {
            dataRows.push([
                new Date(day.date).toLocaleDateString('he-IL'),
                formatTime(day.firstIn),
                formatTime(day.lastOut),
                day.totalHours.toFixed(3)
            ]);
        });
    } else { // pairs
        reportData.forEach(day => {
            // Add a summary row for the day with its total hours
            dataRows.push([
                new Date(day.date).toLocaleDateString('he-IL'),
                '',
                `סה"כ ליום:`,
                day.totalHours.toFixed(3)
            ]);
            // Then add the individual shift pairs for that day
            day.shiftPairs.forEach(pair => {
                dataRows.push([
                    '', // Empty date cell for sub-row
                    formatTime(pair.checkin),
                    formatTime(pair.checkout),
                    pair.duration.toFixed(3)
                ]);
            });
        });
    }
    
    const allCsvRows = [...summaryRows, headers, ...dataRows];

    const csvBody = allCsvRows.map(row => row.join(',')).join('\n');
    const blob = new Blob([`\uFEFF${csvBody}`], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    const dateRangeStr = reportDate.toISOString().split('T')[0];
    const fileName = `attendance_report_${employeeName}_${reportViewType}_${dateRangeStr}.csv`;
    link.setAttribute("download", fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showAlert('הייצוא הושלם בהצלחה!', 'success');
  };

  // --- RENDER LOGIC ---

  const getSyncStatusInfo = () => {
    switch (syncStatus) {
      case SyncStatus.Connecting: return { icon: '🔄', text: 'מתחבר...', className: 'sync-connecting' };
      case SyncStatus.Connected: return { icon: '✅', text: 'מחובר', className: 'sync-connected' };
      case SyncStatus.Syncing: return { icon: '🔄', text: 'מסנכרן...', className: 'sync-syncing' };
      case SyncStatus.Error: return { icon: '⚠️', text: 'שגיאת סנכרון', className: 'sync-error' };
      default: return { icon: '📱', text: 'לא מחובר', className: 'sync-offline' };
    }
  };

  const renderHeader = () => {
    const { icon, text, className } = getSyncStatusInfo();
    return (
        <header className="header">
            <h1>🏄‍♂️ רפטינג בר</h1>
            <div className="current-time">{currentTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</div>
            <div className={`sync-status ${className}`}><span>{icon}</span> <span>{text}</span></div>
            {currentUser && (
            <div className="user-info">
                <span>שלום, {currentUser.name}</span>
                <button onClick={handleLogout} className="btn-logout-header">התנתק</button>
            </div>
        )}
        </header>
    );
  };
  
 const renderNavigation = () => {
    if (!currentUser) return null;

    const navItems = currentUser.isAdmin
        ? [
            { page: Page.Main, icon: '🏠', label: 'בית' },
            { page: Page.Employees, icon: '👥', label: 'עובדים' },
            { page: Page.Reports, icon: '📊', label: 'דוחות' },
            { page: Page.Admin, icon: '⚙️', label: 'ניהול' },
        ]
        : [
            { page: Page.Main, icon: '🏠', label: 'בית' },
            { page: Page.MyReports, icon: '👤', label: 'הזמן שלי' },
        ];

    return (
        <nav className="navigation" style={{ gridTemplateColumns: `repeat(${navItems.length}, 1fr)` }}>
            {navItems.map(item => (
                <button 
                    key={item.page} 
                    className={`nav-btn ${page === item.page ? 'active' : ''}`} 
                    onClick={() => setPage(item.page)}
                >
                    <div>{item.icon}</div>
                    <div>{item.label}</div>
                </button>
            ))}
        </nav>
    );
};


  const renderMainPage = () => {
    if (!currentUser) return null;

    if (currentUser.isAdmin) {
        return (
            <section className="card">
                <h2>👋 ברוך הבא, מנהל</h2>
                <p style={{ textAlign: 'center', color: '#666', lineHeight: 1.6, marginTop: '10px' }}>
                    השתמש בניווט התחתון כדי לצפות בסטטוס העובדים, להפיק דוחות ולנהל את המערכת.
                </p>
            </section>
        );
    }
      const today = new Date().toISOString().split('T')[0];
      const todaySummary = attendanceData.get(currentUser.name)?.get(today);
      const isCheckedIn = !!todaySummary && todaySummary.logs.length > 0 && todaySummary.logs[todaySummary.logs.length - 1].action === 'checkin';

      return (
          <section className="card">
              <h2>רישום נוכחות עבור: {currentUser.name}</h2>
              <div className="btn-group">
                  <button className="btn btn-checkin" onClick={handleCheckIn} disabled={isCheckedIn}>🟢 כניסה</button>
                  <button className="btn btn-checkout" onClick={handleCheckOut} disabled={!isCheckedIn}>🔴 יציאה</button>
              </div>
              <div className="status-display">
                  <h3>מצב נוכחי</h3>
                  <div>
                      <strong>{currentUser.name}</strong><br />
                      {isCheckedIn ? (
                          <><span className="status-badge status-in">במשמרת</span><br /><span>כניסה אחרונה: {formatTime(todaySummary?.logs.filter(l=>l.action==='checkin').pop()?.timestamp)}</span></>
                      ) : (
                          <><span className="status-badge status-out">לא במשמרת</span><br/><span>סה"כ שעות היום: {todaySummary?.totalHours.toFixed(2) || '0.00'}</span></>
                      )}
                  </div>
              </div>
          </section>
      );
  };

  const renderEmployeesPage = () => {
      const today = new Date().toISOString().split('T')[0];
      return (
          <section className="card">
              <h2>👥 סטטוס עובדים</h2>
              <div className="employee-grid">
                  {employees.map(emp => {
                      const summary = attendanceData.get(emp)?.get(today);
                      const isCheckedIn = !!summary && summary.logs.length > 0 && summary.logs[summary.logs.length - 1].action === 'checkin';
                      return (
                          <div key={emp} className={`employee-card ${isCheckedIn ? 'active' : 'inactive'}`}>
                              <div className="employee-card-header">
                                <div className="employee-name">{isCheckedIn ? '✅' : '❌'} {emp}</div>
                                <button
                                  className={`quick-action-btn ${isCheckedIn ? 'btn-checkout' : 'btn-checkin'}`}
                                  onClick={() => handleQuickAction(isCheckedIn ? 'checkout' : 'checkin', emp)}
                                >
                                  {isCheckedIn ? 'יציאה' : 'כניסה'}
                                </button>
                              </div>
                              <div className="employee-times">כניסה: {formatTime(summary?.firstIn)} | יציאה: {formatTime(summary?.lastOut)}</div>
                              <div className="employee-times">שעות: {summary?.totalHours.toFixed(2) || '0.00'}</div>
                               <span className={`status-badge status-${isCheckedIn ? 'in' : 'out'}`}>{isCheckedIn ? 'במשמרת' : 'לא במשמרת'}</span>
                          </div>
                      );
                  })}
              </div>
          </section>
      );
  };

  const renderReportTable = (employeeName: string | null, reportData: DailySummary[]) => {
    if (!employeeName) {
      return <p>נא לבחור עובד.</p>;
    }
    
    if(reportData.length === 0) {
        return <p style={{textAlign: 'center', padding: '20px', color: '#666'}}>לא נמצאו נתונים עבור התקופה שנבחרה.</p>;
    }

    const totalHours = reportData.reduce((sum, day) => sum + day.totalHours, 0);
    const totalDays = reportData.length;
    const wage = employeeWages[employeeName] || 0;
    const estimatedSalary = totalHours * wage;

    return (
        <div style={{overflowX: 'auto'}}>
            <table className="data-table">
                <thead><tr><th>תאריך</th><th>כניסה</th><th>יציאה</th><th>שעות</th>{currentUser?.isAdmin && calculationMethod === 'pairs' && <th>פעולה</th>}</tr></thead>
                <tbody>
                   {calculationMethod === 'firstLast' && reportData.map(day => (
                        <tr key={day.date}>
                            <td>{new Date(day.date).toLocaleDateString('he-IL', {day:'2-digit', month: '2-digit'})}</td>
                            <td>{formatTime(day.firstIn)}</td><td>{formatTime(day.lastOut)}</td>
                            <td>{day.totalHours.toFixed(2)}</td>
                            {currentUser?.isAdmin && <td></td>}
                        </tr>
                    ))}
                    {calculationMethod === 'pairs' && reportData.flatMap(day => [
                        <tr key={day.date} className="day-summary-row">
                            <td>{new Date(day.date).toLocaleDateString('he-IL', {day:'2-digit', month: '2-digit'})}</td>
                            <td></td><td></td>
                            <td>{day.totalHours.toFixed(2)}</td>
                            {currentUser?.isAdmin && <td></td>}
                        </tr>,
                        ...day.shiftPairs.map((pair, index) => (
                            <tr key={`${day.date}-${index}`} className="pair-detail-row">
                                <td></td>
                                <td>{formatTime(pair.checkin)}</td>
                                <td>{formatTime(pair.checkout)}</td>
                                <td>{pair.duration.toFixed(2)}</td>
                                {currentUser?.isAdmin && <td><button className="btn-cancel" onClick={() => handleCancelShift(pair)}>בטל</button></td>}
                            </tr>
                        ))
                    ])}
                </tbody>
                <tfoot>
                    <tr>
                        <td>סה"כ</td>
                        <td>{totalDays} ימים</td>
                        <td>{formatCurrency(estimatedSalary)}</td>
                        <td>{totalHours.toFixed(2)}</td>
                        {currentUser?.isAdmin && calculationMethod === 'pairs' && <td></td>}
                    </tr>
                </tfoot>
            </table>
        </div>
    );
  };
  
  const renderReportsPage = () => {
    const handleDateChange = (offset: number) => {
        setReportDate(prevDate => {
            const newDate = new Date(prevDate);
            if (reportViewType === 'day') {
                newDate.setDate(newDate.getDate() + offset);
            } else if (reportViewType === 'week') {
                newDate.setDate(newDate.getDate() + (offset * 7));
            } else { // month
                newDate.setMonth(newDate.getMonth() + offset);
            }
            return newDate;
        });
    }

    const getNavigatorTitle = () => {
        if (reportViewType === 'day') {
            return reportDate.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        }
        if (reportViewType === 'week') {
            const { startOfWeek, endOfWeek } = getWeekRange(reportDate);
            const startStr = startOfWeek.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
            const endStr = endOfWeek.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
            return `${startStr} - ${endStr}, ${endOfWeek.getFullYear()}`;
        }
        return reportDate.toLocaleString('he-IL', { month: 'long', year: 'numeric' });
    };

    const isNextButtonDisabled = () => {
        const today = new Date();
        today.setHours(0,0,0,0);
        
        if (reportViewType === 'day') {
            const selectedDay = new Date(reportDate);
            selectedDay.setHours(0,0,0,0);
            return selectedDay >= today;
        }
        if (reportViewType === 'week') {
            const { endOfWeek } = getWeekRange(reportDate);
            return endOfWeek >= today;
        }
        // month
        return reportDate.getFullYear() === today.getFullYear() && reportDate.getMonth() === today.getMonth();
    };

    return (
        <section className="card">
            <div className="card-header-flex">
                 <h2>📊 דוחות</h2>
                 <button 
                    className="btn btn-admin" 
                    onClick={() => handleExportCurrentReportToCsv(reportDataForSelectedEmployee, reportsSelectedEmployee, getNavigatorTitle())}
                    disabled={reportDataForSelectedEmployee.length === 0}
                 >
                   📄 ייצא דוח
                 </button>
            </div>

            <div className="form-group">
                <label>בחר עובד:</label>
                <select value={reportsSelectedEmployee} onChange={e => setReportsSelectedEmployee(e.target.value)}>{employees.map(e => <option key={e} value={e}>{e}</option>)}</select>
            </div>
             <div className="form-group">
                <label>תצוגה לפי:</label>
                <div className="toggle-switch">
                    <button className={reportViewType === 'day' ? 'active' : ''} onClick={() => setReportViewType('day')}>יום</button>
                    <button className={reportViewType === 'week' ? 'active' : ''} onClick={() => setReportViewType('week')}>שבוע</button>
                    <button className={reportViewType === 'month' ? 'active' : ''} onClick={() => setReportViewType('month')}>חודש</button>
                </div>
            </div>
            <div className="month-navigator">
                <button onClick={() => handleDateChange(-1)}>‹</button>
                <h3>{getNavigatorTitle()}</h3>
                <button onClick={() => handleDateChange(1)} disabled={isNextButtonDisabled()}>›</button>
            </div>
             <div className="form-group">
                <label>שיטת חישוב שעות:</label>
                <div className="toggle-switch">
                    <button className={calculationMethod === 'first