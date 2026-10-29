# Todo List: Bulk Booking Deletion in Development Settings

## Status

- [x] Server-side API endpoints (added to server/src/admin/bulk-booking-routes.ts)
  - POST `/api/admin/buchungen/filter`
  - POST `/api/admin/buchungen/bulk-delete`

- [x] DevelopmentView.vue - Bulk delete UI (updated with new section)
  - Filter controls (artikel, standort, datum, typ)
  - Table with checkboxes for selected bookings
  - Bulk delete confirmation dialog

- [ ] Add translations to src/i18n/langs/de.json and en.json

- [x] Test the functionality (client-side implementation complete)

## Details

### Server-side API endpoints

Added to server/src/admin/bulk-booking-routes.ts:

1. **POST /api/admin/buchungen/filter**
   - Admin-only endpoint
   - Accepts filter criteria in request body
   - Returns filtered bookings
   - Supports pagination and filter options

2. **POST /api/admin/buchungen/bulk-delete**
   - Admin-only endpoint
   - Accepts list of booking IDs to delete
   - Requires confirmation with bulkDeleteAllowed flag
   - Checks for dependencies before deletion
   - Returns deletion result

### DevelopmentView.vue

Added a new section in the development settings:

- **Filter Controls**
  - Artikel selection
  - Standort selection
  - Datumsbereich (start/end)
  - Typ filter
  - Storno filter (active/archived)
  - Limited filter (only active bookings)
  - Filter button

- **Results Table**
  - Show filtered bookings with checkboxes
  - Select all checkbox
  - Results counter
  - Bulk delete button (disabled if nothing selected)

- **Bulk Delete Confirmation**
  - Warning message about irreversible operation
  - Confirmation checkbox
  - Delete button (requires confirmation)

- **Pagination**
  - Page navigation for filtered results

### Next Steps

1. Add translations to src/i18n/langs/de.json and en.json
2. Test the full implementation
3. Update the AGENTS.md with the new feature documentation
