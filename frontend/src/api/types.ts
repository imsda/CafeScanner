export type MealType = 'BREAKFAST' | 'LUNCH' | 'DINNER';

export interface ScanPerson {
  id?: number;
  firstName: string;
  lastName: string;
  personId?: string;
  breakfastRemaining: number;
  lunchRemaining: number;
  dinnerRemaining: number;
  active?: boolean;
}

export interface ScanResponse {
  ok: true;
  person: ScanPerson;
  mealType: MealType;
}

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

export interface ReportsSummaryResponse {
  from: string;
  to: string;
  stats: {
    scans: number;
    breakfastsServed: number;
    lunchesServed: number;
    dinnersServed: number;
    failedScans: number;
  };
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
