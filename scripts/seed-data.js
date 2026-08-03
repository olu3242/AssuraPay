const fs = require('fs');
const path = require('path');
const target = path.resolve(__dirname, '../apps/web/data/assurapay.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({
  workspaces: [],
  organizations: [],
  contracts: [],
  blueprints: [],
  milestones: [],
  dodPackages: [],
  evidenceItems: [],
  validationResults: [],
  acceptanceDecisions: [],
  certificates: [],
  paymentEligibility: [],
}, null, 2));
console.log('Seed data placeholder created');
