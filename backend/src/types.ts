export type MealKey = 'BREAKFAST' | 'LUNCH' | 'DINNER';

export type FailureReason =
  | 'INVALID_CODE'
  | 'INACTIVE_PERSON'
  | 'NO_ACTIVE_MEAL_PERIOD'
  | 'NO_MEALS_REMAINING'
  | 'COOLDOWN_ACTIVE';
