// A line's name where room is short. The name may be cut («…»); the month a carried
// share is for — « · για Οκτώβριο 2026» — never is: it is what tells two lines of the
// same expense apart, and cut off at the end of a long name it was the first thing
// to go. A line with no such month renders exactly as it always did.
//
// `label` is the whole label, `suffix` the month part it ends with ('' for a line of
// the month itself): lineLabels.js `buildingLineLabel` and `forMonthSuffix`. The
// element that holds it must not truncate when there is a suffix (`min-w-0` instead).
export default function LineName({ label, suffix }) {
  if (!suffix) return label;
  return (
    <span className="flex min-w-0">
      <span className="truncate">
        {label.slice(0, label.length - suffix.length)}
      </span>
      <span className="ml-1 shrink-0 whitespace-nowrap">{suffix.trim()}</span>
    </span>
  );
}
