import { fetchPropertyExpenses } from '../utils/restcalls';
import { useQuery } from '@tanstack/react-query';

/**
 * Fetches the per-property expense panel payload (current-month + lifetime
 * totals). Reuses the `computeBuildingChargeForProperty` pipeline server-side
 * so numbers match the rent computation exactly.
 *
 * @param {string|undefined} propertyId
 * @param {{ from?: string, to?: string }} [range] YYYYMM strings, optional
 */
export default function useFetchPropertyExpenses(propertyId, { from, to } = {}) {
  return useQuery({
    queryKey: ['property-expenses', propertyId, from, to],
    queryFn: () => fetchPropertyExpenses(propertyId, { from, to }),
    enabled: !!propertyId && propertyId !== 'new'
  });
}
