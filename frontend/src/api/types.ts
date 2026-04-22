export type MealType = 'BREAKFAST' | 'LUNCH' | 'DINNER';

export interface ScanPerson {
  firstName: string;
  lastName: string;
  breakfastRemaining: number;
  lunchRemaining: number;
  dinnerRemaining: number;
}

export interface ScanResponse {
  person: ScanPerson;
  mealType: MealType;
}

export interface ApiErrorResponse {
  error?: string;
}
