import type { MealTrackingMode, MealType, ScanPerson } from "../api/types";
import { formatMealLabel, modeLabel } from "../lib/format";

export type ScanResultState =
  | (
      | {
          ok: true;
          person: ScanPerson;
          mealType: MealType;
          mealTrackingMode: MealTrackingMode;
          scannedValue?: string;
          remainingAvailableTodayForMeal?: number;
          remainingAvailableCount?: number;
          selectedPerson?: string;
          selectedEntitlementId?: number;
          sourceRowKey?: string;
          sourceRow?: number | null;
          redeemedEntitlement?: {
            id: number;
            personName?: string | null;
            personId: string;
            mealDay: string;
            mealDate: string;
            sourceRowKey?: string;
            sourceSheetRow?: number | null;
          };
        }
      | { ok: false; error: string }
    )
  | null;

export function ScanResultCard({ result }: { result: ScanResultState }) {
  if (!result)
    return (
      <div className="scan-result info">
        <h3>Ready</h3>
        <p>Scan a person ID barcode or use USB scanner/manual ID entry.</p>
      </div>
    );
  if (!result.ok)
    return (
      <div className="scan-result fail">
        <h3>Scan Failed</h3>
        <p>{result.error}</p>
      </div>
    );

  const tally =
    result.mealType === "BREAKFAST"
      ? result.person.breakfastCount
      : result.mealType === "LUNCH"
        ? result.person.lunchCount
        : result.person.dinnerCount;

  const sharedId = result.scannedValue || result.person.personId || "N/A";
  return (
    <div className="scan-result success">
      <h3>
        {result.mealTrackingMode === "camp_meeting"
          ? "Meal Redeemed"
          : result.mealTrackingMode === "countdown"
            ? "Meal Deducted"
            : "Meal Recorded"}
      </h3>
      <p className="scan-person">
        {result.person.firstName} {result.person.lastName}
      </p>
      <p>
        Shared ID: <strong>{sharedId}</strong>
      </p>
      <p>
        Meal: <strong>{formatMealLabel(result.mealType)}</strong>
      </p>
      <p>
        Mode: <strong>{modeLabel(result.mealTrackingMode)}</strong>
      </p>
      {result.mealTrackingMode === "camp_meeting" ? (
        <>
          <p>
            {result.selectedPerson || result.redeemedEntitlement?.personName
              ? `Meal redeemed for ${result.selectedPerson || result.redeemedEntitlement?.personName}`
              : "Meal redeemed."}
          </p>
          <p>
            Remaining available today for this meal:{" "}
            <strong>{result.remainingAvailableCount ?? result.remainingAvailableTodayForMeal ?? 0}</strong>
          </p>
        </>
      ) : result.mealTrackingMode === "countdown" ? (
        <>
          <p>{formatMealLabel(result.mealType)} deducted by 1.</p>
          <p>
            Remaining {formatMealLabel(result.mealType).toLowerCase()}:{" "}
            <strong>
              {result.mealType === "BREAKFAST"
                ? result.person.breakfastRemaining
                : result.mealType === "LUNCH"
                  ? result.person.lunchRemaining
                  : result.person.dinnerRemaining}
            </strong>
          </p>
        </>
      ) : (
        <>
          <p>
            {formatMealLabel(result.mealType)} tally: <strong>{tally}</strong>
          </p>
          <p>
            Total meals served: <strong>{result.person.totalMealsCount}</strong>
          </p>
        </>
      )}
    </div>
  );
}
