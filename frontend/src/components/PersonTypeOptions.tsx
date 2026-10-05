import { PERSON_TYPE_OPTIONS } from "../lib/format";

export function PersonTypeOptions() {
  return <>{PERSON_TYPE_OPTIONS.map((option) => (
    <option key={option.value} value={option.value}>{option.code}: {option.label}</option>
  ))}</>;
}
