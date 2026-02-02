// Whitelist of Intercom ticket statuses that should trigger Asana task creation
// Only tickets with these statuses will create tasks in Asana
const whitelistStatus = [
  'Case Report Created (bn)',
  'Submitted',
];

export default whitelistStatus;
