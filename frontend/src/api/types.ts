export type MealType = 'BREAKFAST' | 'LUNCH' | 'DINNER';
export type MealTrackingMode = 'camp_meeting' | 'countdown' | 'tally';
export type MealDay = 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT';

export interface ScanPerson {
  id?: number;
  firstName: string;
  lastName: string;
  personId?: string;
  breakfastRemaining: number;
  lunchRemaining: number;
  dinnerRemaining: number;
  breakfastCount: number;
  lunchCount: number;
  dinnerCount: number;
  totalMealsCount: number;
  active?: boolean;
}

export interface ScanSuccessResponse {
  ok: true;
  person: ScanPerson;
  mealType: MealType;
  scannedValue?: string;
  mealTrackingMode: MealTrackingMode;
  remainingAvailableTodayForMeal?: number;
  redeemedEntitlement?: {
    id: number;
    personName?: string | null;
    personId: string;
    mealDay: MealDay;
    mealDate: string;
  };
}

export interface ScanPendingSelectionResponse {
  ok: false;
  pendingSelection: true;
  reason: 'MULTIPLE_ENTITLEMENTS_FOUND';
  scannedValue: string;
  originalScannedValue?: string;
  mealType: MealType;
  mealDay: MealDay;
  options: Array<{
    entitlementId: number;
    personName: string;
  }>;
}

export type ScanResponse = ScanSuccessResponse | ScanPendingSelectionResponse;

export interface ScanFailureResponse {
  ok: false;
  error: string;
  reason?: string;
  mealType?: MealType;
  person?: ScanPerson;
}

export interface ApiErrorResponse {
  error?: string;
}

export interface Settings {
  id: number;
  schoolName: string;
  timezone: string;
  breakfastStart: string;
  breakfastEnd: string;
  lunchStart: string;
  lunchEnd: string;
  dinnerStart: string;
  dinnerEnd: string;
  scannerCooldownSeconds: number;
  scannerDiagnosticsEnabled: boolean;
  stationName: string;
  enableSounds: boolean;
  allowManualMealOverride: boolean;
  hideInactiveByDefault: boolean;
  mealTrackingMode: MealTrackingMode;
  updatedAt: string;
}

export interface ReportsSummaryResponse {
  from: string;
  to: string;
  mealTrackingMode: MealTrackingMode;
  stats: {
    scans: number;
    breakfastsServed: number;
    lunchesServed: number;
    dinnersServed: number;
    failedScans: number;
  };
  mealTotalsByPerson: Array<{
    personId: string;
    firstName: string;
    lastName: string;
    breakfasts: number;
    lunches: number;
    dinners: number;
    total: number;
  }>;
  perPersonUsage: Array<{
    personId: string;
    firstName: string;
    lastName: string;
    breakfasts: number;
    lunches: number;
    dinners: number;
    total: number;
  }>;
  remainingBalanceSummary: {
    breakfastRemaining: number;
    lunchRemaining: number;
    dinnerRemaining: number;
  };
  entitlementSummary: {
    totalEntitlements: number;
    totalRedeemed: number;
    totalRemaining: number;
  };
  tallySummary: {
    breakfastCount: number;
    lunchCount: number;
    dinnerCount: number;
    totalMealsCount: number;
  };
  transactions: Array<{
    id: number;
    timestamp: string;
    scannedValue: string;
    mealType: string;
    result: string;
    failureReason: string | null;
    stationName: string | null;
    person: null | {
      firstName: string;
      lastName: string;
      personId: string;
    };
  }>;
}
