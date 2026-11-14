// Emergent visual-database domains as pure DATA over the generic visual-database primitive.
//
// Each domain = one entity-type trio + one GENERIC board carrier record
// (`kind:"board"`) holding its own `visual-database.fields` / `visual-database.views`
// DATA, the SAME descriptor grammar a consumer's own things-file ships, addressed
// generically under visual-database.
// Zero new code per domain: a new domain is one more DATA row here. This module
// is pure (no I/O) so both the live-author script and the offline decode test
// share it.

// Each row: [slug, label, stages[], extraFields[[id,label,role,key]]]
export const EMERGENT_CONFIGS = [
  ['investors','Investors',['Researching','Intro made','Meeting','Diligence','Committed','Passed'],[['check-size','Check size','metric','check_size'],['fund','Fund','badge','fund']]],
  ['partners','Partners',['Prospect','Talking','Pilot','Active','Lapsed'],[['partnership-type','Type of deal','badge','partnership_type']]],
  ['podcast-guests','Podcast guests',['Idea','Invited','Scheduled','Recorded','Published'],[['episode','Episode','badge','episode'],['audience','Audience','metric','audience_size']]],
  ['job-candidates','Job candidates',['Applied','Screen','Interview','Offer','Hired','Declined'],[['role','Role','badge','role'],['salary','Salary ask','metric','salary_ask']]],
  ['vendors','Vendors',['Evaluating','Negotiating','Active','Renewal due','Churned'],[['category','Category','badge','category'],['annual-cost','Annual cost','metric','annual_cost']]],
  ['mentors','Mentors',['Wishlist','Reached out','Talking','Meeting monthly','Dormant'],[['expertise','Expertise','badge','expertise']]],
  ['press-contacts','Press contacts',['Identified','Pitched','Responded','Covered us','Gone cold'],[['outlet','Outlet','badge','outlet']]],
  ['community-members','Community members',['New','Active','Champion','At risk','Left'],[['joined','Joined','badge','joined_via']]],
  ['church-members','Church members',['Visitor','Regular','Member','Serving','Moved away'],[['ministry','Ministry','badge','ministry']]],
  ['gym-clients','Gym clients',['Trial','Active','Paused','Cancelled'],[['plan','Plan','badge','plan'],['sessions','Sessions/mo','metric','sessions_per_month']]],
  ['tennis-students','Tennis students',['Trial lesson','Enrolled','Advancing','Competing','Alumni'],[['level','Level','badge','level'],['coach','Coach','badge','coach']]],
  ['real-estate-leads','Real-estate leads',['New lead','Qualified','Touring','Offer','Closed','Lost'],[['budget','Budget','metric','budget'],['area','Area','badge','area']]],
  ['wholesale-buyers','Wholesale buyers',['Prospect','Sample sent','Negotiating','Ordering','Repeat','Dormant'],[['volume','Monthly volume','metric','monthly_volume']]],
  ['affiliate-partners','Affiliate partners',['Applied','Approved','Active','Top performer','Inactive'],[['commission','Commission %','metric','commission_pct']]],
  ['book-readers','Book readers',['Subscriber','Sampled','Bought','Reviewed','Superfan'],[['book','Book','badge','book']]],
  ['newsletter-vips','Newsletter VIPs',['Subscriber','Engaged','Replied','Advocate'],[['open-rate','Open rate','metric','open_rate']]],
  ['event-sponsors','Event sponsors',['Prospect','Pitched','Negotiating','Signed','Renewed','Declined'],[['tier','Tier','badge','tier'],['amount','Amount','metric','amount']]],
  ['beta-testers','Beta testers',['Waitlist','Invited','Onboarded','Active','Feedback given','Churned'],[['platform','Platform','badge','platform']]],
  ['suppliers','Suppliers',['Sourcing','Quoted','Sampled','Approved','Primary','Backup'],[['lead-time','Lead time (days)','metric','lead_time_days']]],
  ['contractors','Contractors',['Sourced','Interviewed','Trial task','Engaged','Preferred','Ended'],[['rate','Rate','metric','hourly_rate'],['skill','Skill','badge','skill']]],
  ['speaking-gigs','Speaking gigs',['Target','Applied','Accepted','Scheduled','Delivered'],[['event','Event','badge','event'],['fee','Fee','metric','fee']]],
  ['grant-applications','Grant applications',['Found','Drafting','Submitted','Interview','Awarded','Rejected'],[['amount','Amount','metric','amount']]],
  ['open-source-contributors','OSS contributors',['First PR','Recurring','Maintainer','Core team','Inactive'],[['repo','Repo','badge','repo']]],
  ['landlords','Landlords',['Contacted','Viewing','Negotiating','Leased','Past'],[['property','Property','badge','property'],['rent','Rent','metric','rent']]],
  ['students-parents','Student parents',['Inquiry','Trial booked','Enrolled child','Engaged','Alumni family'],[['child','Child','badge','child_name']]],
  ['coaching-clients','Coaching clients',['Discovery','Proposal','Active','Renewal','Completed'],[['package','Package','badge','package'],['mrr','MRR','metric','mrr']]],
  ['wedding-clients','Wedding clients',['Inquiry','Consult','Booked','Planning','Delivered'],[['date','Wedding date','badge','wedding_date'],['budget','Budget','metric','budget']]],
  ['donors','Donors',['Prospect','Cultivating','Asked','Gave','Recurring','Lapsed'],[['capacity','Capacity','metric','capacity'],['cause','Cause','badge','cause']]],
  ['franchisees','Franchisees',['Lead','Qualified','Discovery day','Signed','Open','Exited'],[['territory','Territory','badge','territory']]],
  ['influencer-collabs','Influencer collabs',['Identified','Outreach','Negotiating','Content live','Repeat'],[['followers','Followers','metric','followers'],['platform','Platform','badge','platform']]],
  ['patent-attorneys','Patent attorneys',['Researching','Consult','Engaged','Filing','Granted'],[['matter','Matter','badge','matter']]],
  ['acquisition-targets','Acquisition targets',['Watching','Contacted','NDA','Diligence','LOI','Closed','Passed'],[['valuation','Valuation','metric','valuation']]],
  ['podcast-sponsors','Podcast sponsors',['Prospect','Media kit sent','Negotiating','Live','Renewed'],[['cpm','CPM','metric','cpm']]],
  ['alumni-network','Alumni',['Graduated','Engaged','Mentoring','Donor','Lost touch'],[['class','Class of','badge','class_year']]],
  ['clinical-patients','Clinic patients',['Referral','Intake','In treatment','Follow-up','Discharged'],[['program','Program','badge','program']]],
  ['saas-upsells','SaaS upsell targets',['Signal detected','Qualified','Outreach','Demo','Expanded','Declined'],[['plan','Current plan','badge','current_plan'],['arr','ARR','metric','arr']]],
];

// Build the generic visual-database fields + views DATA for one domain. This
// mirrors a consumer things-file's own `visual-database.fields` and
// `visual-database.views` rows exactly.
export function buildEmergentBoard(slug, label, stages, extras) {
  const typeId = `type:${slug}`;
  const fields = { kind: 'visual-database.fields', version: 2, descriptors: [
    { id: 'record-id', label: 'Record', role: 'id', paths: [['payload', 'subject_id'], ['address']], editable: false },
    { id: 'record-title', label: 'Name', role: 'title', paths: [['payload', 'display_name']], writePath: ['payload', 'display_name'] },
    { id: 'record-kind', label: 'Type', role: 'kind', paths: [['payload', 'entity_type']], writePath: ['payload', 'entity_type'] },
    { id: 'record-lane', label: 'Stage', role: 'lane', paths: [['payload', 'stage']], writePath: ['payload', 'stage'],
      domain: { values: stages.map((s, i) => ({ id: s, label: s, order: (i + 1) * 10 })) } },
    { id: 'record-date', label: 'Last activity', role: 'date', shape: 'temporal',
      paths: [['payload', 'last_activity_at']], writePath: ['payload', 'last_activity_at'] },
    ...extras.map(([id, l, role, key]) => ({ id, label: l, role, paths: [['payload', key]], writePath: ['payload', key] })),
  ] };
  const views = { kind: 'visual-database.views', version: 2, views: [
    { id: `${slug}-pipeline`, label, kind: 'board', order: 10, lanes: [],
      filters: [{ field: 'record-kind', equals: [typeId] }],
      projectionRules: [{ id: 'grouping', operation: 'view-group', sourceFieldId: 'record-lane', order: 10 }] },
    { id: `${slug}-table`, label: `${label} table`, kind: 'table', order: 20, lanes: [],
      filters: [{ field: 'record-kind', equals: [typeId] }] },
  ], palette: ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4'] };
  return { slug, typeId, label, fields, views };
}

// The full generic write set for one domain: entity-type trio + ONE generic
// board carrier record (kind:"board", generic address).
export function domainWrites(slug, label, stages, extras) {
  const { typeId, fields, views } = buildEmergentBoard(slug, label, stages, extras);
  return [
    { address_label: `entity|${typeId}`, address_mode: 'identity_text',
      path_labels: ['current-item', 'published-record'], payload: { table: 'entity', id: typeId } },
    // `type:crm-entity-type` names a package deleted on 2026-09-05 and is stale
    // vocabulary. It is deliberately NOT renamed here: this script authors LIVE
    // rows, the type_id is part of the address, and changing it in source would
    // author a second parallel type on the next run rather than move the first.
    // Renaming it is a live-data migration that has to retract the old rows, so
    // it is tracked in the plan rather than done as a source edit.
    { address_label: `entity_types|${typeId}|type:crm-entity-type`, address_mode: 'identity_text',
      path_labels: ['current-item', 'published-record'], payload: { table: 'entity_types', entity_id: typeId, type_id: 'type:crm-entity-type' } },
    { address_label: `package::visual-database::board::${slug}`, address_mode: 'identity_text',
      path_labels: ['current-item', 'published-record'],
      payload: { kind: 'board', id: slug, label, entity_type: typeId, fields, views } },
  ];
}
