// Rollen und Berechtigungen im Client.
//
// Der Server ist die einzige Quelle der Wahrheit: `server/src/domain/rollen.ts`
// ist dependency-frei und wird hier direkt importiert — damit gibt es keine
// doppelte Pflege der Berechtigungs-IDs.
//
// ---------- Wichtig: Server ist die Quelle der Wahrheit fuer die Rechte ----------
//
// Die *effektiven* Rechte des eingeloggten Users kommen vom Server (Login-
// Antwort bzw. `/api/auth/me`) und stehen in der Session. Die Matrix hier ist
// nur der Fallback fuer Sessions, die noch aus einer aelteren Version
// stammen (dort gab es nur die Einzelrolle).

export {
  BERECHTIGUNG_INFO,
  PERMISSIONS,
  ROLLEN,
  ROLLEN_BEREECHTIGUNGEN,
  ROLLEN_INFO,
  berechtigungenFuer,
  hatBerechtigung,
  istAdmin,
  istBerechtigung,
  istRolle,
  legacyRolle,
  normalisiereRollen,
  type BerechtigungInfo,
  type Permission,
  type Rolle,
  type RollenInfo,
} from '../../server/src/domain/rollen'
