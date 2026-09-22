/* Meds 2.0 interaction prototype.
   Illustrative only: state lives in memory, there is no server and no real drug data.
   The point is to demonstrate the flow implied by the three-layer model. */

(function () {
  'use strict';

  /* Dates are relative to the day the prototype is opened, so the seeded story
     reads the same whenever it is reviewed and the date pickers behave. */
  function d(offsetDays) {
    var t = new Date();
    t.setHours(12, 0, 0, 0);
    t.setDate(t.getDate() + offsetDays);
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0')
      + '-' + String(t.getDate()).padStart(2, '0');
  }
  function ts(offsetDays, time) { return d(offsetDays) + ' ' + time; }

  var TODAY = d(0);

  var USERS = {
    prescriber: { name: 'Mr A Prescriber', role: 'Consultant ophthalmologist', canPrescribe: true, canPGD: false, canDispense: false },
    nurse:      { name: 'Sr B Nurse',      role: 'Ophthalmic nurse',           canPrescribe: false, canPGD: true, canDispense: false },
    pharmacist: { name: 'Ms C Pharmacist', role: 'Pharmacist',                 canPrescribe: false, canPGD: false, canDispense: true }
  };

  /* The secondary signatory roles OpenEyes seeds today in `secondary_signatory`.
     The pharmacy worklist treats an order as outstanding until all of them are signed. */
  var PHARMACY_ROLES = ['Screened by', 'Dispensed by', 'Checked by', 'Counselled by'];

  var ARTEFACT_STATES = {
    draft:     { label: 'Draft',     note: 'Unsigned, and an instruction to nobody. A signature attests to the record as it stands when the PIN is typed, so the order shows that beside what was asked for, or beside what was signed before if a signature has just come off.' },
    signed:    { label: 'Signed',    note: 'Signed. These directions were snapshotted at signature and no longer follow the record. To amend it, edit the order and sign again: it keeps its number and its history, and the signature comes off until you re-enter a PIN.' },
    issued:    { label: 'Issued',    note: 'Released. It can be cancelled and reissued, but not edited or re-signed.' },
    complete:  { label: 'Complete',  note: 'Every signatory role has signed. Off the pharmacy worklist.' },
    cancelled: { label: 'Cancelled', note: 'Withdrawn. Stays visible to pharmacy rather than disappearing.' }
  };

  /* Responsibility to supply: who we are relying on to get this drug to the
     patient from now on.

     "Responsibility" rather than "supplies" on purpose. We cannot observe that a
     GP dispenses anything; we can only record who we have made responsible. The
     header states an assignment, which is true, instead of a fact we have not
     checked, which may not be.

     Every value has to change a behaviour or it should not exist. Hospital
     changes the letter and means an order should exist. GP changes the letter and
     tells reconciliation to expect the drug in the GP record. Patient changes the
     letter and tells reconciliation NOT to expect it, which is the only thing that
     stops an over-the-counter lubricant reading as a missing item forever. Blank
     changes nothing, which is exactly right for a drug nobody has thought about.

     Hospital then GP is the fourth, and it exists because the handover is the
     common case and was previously modelled as an event rather than a state: the
     row said Hospital, and issuing an order silently rewrote it to GP. That has
     two problems. The drug has not become the GP's responsibility yet, because we
     have just handed the patient a month of it. And a value that changes itself
     is the same failure as a stop date that recomputes itself. As a state it is
     stable, it says exactly what the letter needs to say, and reconciliation can
     treat it as "expect this in the GP record eventually".

     "Nobody supplying" and "Not known" were in an earlier draft and are gone:
     neither changed any behaviour that blank does not already cover, and "Not
     known" was the default, so most rows read "Not known", which is noise. */
  var RESPONSIBILITY = {
    '':             '\u2013',
    hospital:       'Hospital',
    gp:             'GP',
    other_provider: 'Other care provider',
    patient:        'Patient'
  };
  var RESP_ORDER = ['', 'hospital', 'gp', 'other_provider', 'patient'];

  /* Provenance: how we came to know about the drug. Set at the adder's commit
     and never rewritten. gp_feed is reserved for the reconciliation feed and
     cannot be asserted by hand. */
  var SOURCE = {
    started_here:       'Started in this service',
    patient_reported:   'Patient reported',
    gp_letter:          'GP letter',
    shared_care_record: 'Shared care record',
    provider_letter:    "Another provider's letter",
    recommended:        'Recommended',
    gp_feed:            'GP feed'
  };
  var SOURCE_EXISTING = ['patient_reported', 'gp_letter', 'shared_care_record', 'provider_letter'];

  /* The default, used when nothing has been set explicitly. Already taking it:
     GP. We start it and it ends: Hospital. We start it and it is ongoing: GP.
     Same null-means-derived pattern as eye relevance: the row shows the derived
     value in muted text, an explicit choice in normal text, and only explicit
     choices go in the change history. Issuing never changes this. */
  function defaultSupply(e) {
    if (e.existing) return 'gp';
    return courseEnds(e) ? 'hospital' : 'gp';
  }

  function courseEnds(e) {
    return !!(e.end || (e.duration && e.duration !== 'Ongoing'));
  }

  function effectiveSupply(e) {
    return (e.supply === null || e.supply === undefined) ? defaultSupply(e) : e.supply;
  }

  /* The existing dispense conditions, with the locations each one allows, exactly
     as the real lookups hold them. These live on the ORDER, not on the medication.
     The flags are the ones section 7a proposes: stated on the condition instead of
     inferred from its name. `suggestsGpContinues` drives a one-click advisory when
     the order and the row disagree; it never rewrites the row on its own. */
  var DISPENSE_CONDITIONS = [
    { id: 'hospital', name: 'Hospital to supply',                    locations: ['Pharmacy', 'TTO Pre-Pack', 'Ward Fridge'],
                      prescribes: true, form: 'hospital', needsLocation: true, pharmacy: true, suggestsGpContinues: false },
    { id: 'hospgp',   name: 'Hospital to supply and GP to continue', locations: ['Pharmacy', 'TTO Pre-Pack', 'Ward Fridge'],
                      prescribes: true, form: 'hospital', needsLocation: true, pharmacy: true, suggestsGpContinues: true },
    { id: 'fp10',     name: 'Print to FP10',                         locations: ['N/A'],
                      prescribes: true, form: 'fp10', overprint: true, suggestsGpContinues: false },
    { id: 'pgd',      name: 'Supply under PGD',                      locations: ['Ward Fridge', 'Pharmacy'],
                      pgd: true, form: 'pgd', needsLocation: true, suggestsGpContinues: false }
  ];

  /* One artefact, one form type. The form is chosen when the order is generated,
     not per drug, so a prescription can never hold a mixture that only half of
     it can be printed on. */
  var FORM_TYPES = {
    hospital: { label: 'Hospital prescription', phrase: 'hospital prescription', conditions: ['hospital', 'hospgp'], needsLocation: true, pharmacy: true },
    fp10:     { label: 'FP10',                  phrase: 'FP10 prescription',     conditions: ['fp10'],               needsLocation: false, pharmacy: false },
    pgd:      { label: 'Supply under PGD',      phrase: 'PGD supply',            conditions: ['pgd'],                needsLocation: true, pharmacy: false }
  };
  /* The label is a button caption and the phrase is what the same thing is
     called mid-sentence. Lower-casing the caption gives "the supply under pgd". */
  function formPhrase(form) { return (FORM_TYPES[form] || {}).phrase || 'prescription'; }
  function formPhraseA(form) { return (form === 'fp10' ? 'an ' : 'a ') + formPhrase(form); }
  function condById(id) { return DISPENSE_CONDITIONS.filter(function (c) { return c.id === id; })[0] || null; }
  var COND_LABELS = DISPENSE_CONDITIONS.reduce(function (m, c) { m[c.id] = c.name; return m; }, {});

  /* Two institutions, differing exactly as real ones do: which conditions are
     mapped, whether overprint is on, and which condition is the default. */
  var INSTITUTIONS = {
    qah: {
      name: 'QAH', overprint: true,
      conditions: ['hospital', 'hospgp', 'fp10', 'pgd'],
      defaultCondition: 'hospital'
    },
    gosport: {
      name: 'Gosport', overprint: false,
      conditions: ['hospital', 'pgd'],
      defaultCondition: 'hospital'
    }
  };
  function inst() { return INSTITUTIONS[STATE.institution]; }

  /* PGDs, with the users named on them. Authorisation is per protocol, so a
     drug is PGD-suppliable for this user only if it sits in one of these. */
  var PGDS = [
    { id: 'PGD-1', name: 'Dilating drops (nurse-led clinic)', users: ['nurse'],
      items: [
        { drug: 'Tropicamide',   dose: '1', unit: 'drop', freq: 'As required', route: 'Eye', lat: 'Both', location: 'Ward Fridge' },
        { drug: 'Phenylephrine', dose: '1', unit: 'drop', freq: 'As required', route: 'Eye', lat: 'Both', location: 'Ward Fridge' }
      ] },
    { id: 'PGD-2', name: 'Ocular lubricants', users: ['nurse'],
      items: [
        { drug: 'Hypromellose', dose: '1', unit: 'drop', freq: 'Four times daily', route: 'Eye', lat: 'Both', location: 'Pharmacy' }
      ] }
  ];
  function myPgds() {
    return PGDS.filter(function (p) { return p.users.indexOf(STATE.user) >= 0; });
  }
  /* "May this user supply this drug under a PGD?" is derived, not stored. */
  function pgdForDrug(drug) {
    var hit = null;
    myPgds().forEach(function (p) {
      p.items.forEach(function (i) { if (i.drug === drug && !hit) hit = { pgd: p, item: i }; });
    });
    return hit;
  }

  /* Standard sets, carrying the same defaults the real medication_set_item does. */
  /* Sets carry no side, which is faithful: `medication_set_item` has columns for
     form, dose, unit, route, frequency, duration and the two supply fields, and
     no laterality column at all. A set cannot know which eye it is for, so where
     its route takes a side the side has to come from somewhere else. */
  /* Durations are on the items because `medication_set_item` has
     `default_duration_id`. A post-op set that did not say how long its drops run
     for would not be much of a set, and the difference between the set's course
     and the patient's is one of the things most worth catching. */
  var DRUG_SETS = [
    { id: 'SET-1', name: 'Cataract post-op', items: [
        { drug: 'Dexamethasone',   dose: '1', unit: 'drop', freq: 'Four times daily', route: 'Eye', duration: '1 month', condition: 'hospital', location: 'TTO Pre-Pack' },
        { drug: 'Chloramphenicol', dose: '1', unit: 'drop', freq: 'Four times daily', route: 'Eye', duration: '7 days',  condition: 'hospital', location: 'TTO Pre-Pack' }
      ] },
    { id: 'SET-2', name: 'Glaucoma first line', items: [
        { drug: 'Latanoprost',  dose: '1', unit: 'drop', freq: 'At night',     route: 'Eye', duration: 'Ongoing', condition: 'fp10',  location: 'N/A' },
        { drug: 'Brimonidine',  dose: '1', unit: 'drop', freq: 'Twice daily',  route: 'Eye', duration: 'Ongoing', condition: 'fp10',  location: 'N/A' }
      ] },
    { id: 'SET-3', name: 'Dry eye', items: [
        { drug: 'Hypromellose', dose: '1', unit: 'drop', freq: 'Four times daily', route: 'Eye', duration: 'Ongoing', condition: 'self', location: 'Home' }
      ] },
    { id: 'SET-4', name: 'Cataract post-op with cover', items: [
        { drug: 'Dexamethasone',   dose: '1', unit: 'drop', freq: 'Four times daily', route: 'Eye',  duration: '1 month', condition: 'hospital', location: 'TTO Pre-Pack' },
        { drug: 'Chloramphenicol', dose: '1', unit: 'drop', freq: 'Four times daily', route: 'Eye',  duration: '7 days',  condition: 'hospital', location: 'TTO Pre-Pack' },
        { drug: 'Acetazolamide',   dose: '250', unit: 'mg', freq: 'Twice daily',      route: 'Oral', duration: '3 days',  condition: 'hospital', location: 'TTO Pre-Pack' }
      ] }
  ];

  /* Which event the element is sitting in. An operation note knows its operated
     eye; an examination does not. Everything about how a side is defaulted follows
     from that one difference, so it is a first-class piece of state here. */
  var HOSTS = {
    exam:      { label: 'Examination',                  operatedEye: null },
    'op-r':    { label: 'Operation note, right eye',    operatedEye: 'Right' },
    'op-l':    { label: 'Operation note, left eye',     operatedEye: 'Left' },
    'op-b':    { label: 'Operation note, both eyes',    operatedEye: 'Both' },
    'op-none': { label: 'Operation note, eye not set',  operatedEye: null }
  };
  function host() { return HOSTS[STATE.host] || HOSTS.exam; }

  /* The prototype's stand-in for `medication_route.has_laterality`. */
  function routeTakesSide(route) { return route === 'Eye' || route === 'Intravitreal'; }

  /* Two sides overlap if they could describe the same eye. Left and Right are
     separate threads and never conflict; Both overlaps everything. */
  function sidesOverlap(a, b) {
    if (!a || !b) return true;
    return a === b || a === 'Both' || b === 'Both';
  }

  /* The patient's recorded diagnoses, standing in for the Diagnoses 2.0 list.
     Indication is chosen from these rather than typed, which is what keeps it
     to one tap and keeps it coded. */
  var DIAGNOSES = [
    { id: 'D1', name: 'Primary open angle glaucoma', eye: true,  lat: 'Both' },
    { id: 'D2', name: 'Anterior uveitis',            eye: true,  lat: 'Right' },
    { id: 'D3', name: 'Dry eye disease',             eye: true,  lat: 'Both' },
    { id: 'D4', name: 'Rheumatoid arthritis',        eye: false, lat: '' },
    { id: 'D5', name: 'Hypertension',                eye: false, lat: '' },
    { id: 'D6', name: 'Type 2 diabetes',             eye: false, lat: '' }
  ];
  function dxById(id) { return DIAGNOSES.filter(function (d) { return d.id === id; })[0] || null; }

  var CATALOGUE = [
    { drug: 'Latanoprost',            sub: '50 micrograms/ml eye drops',         group: 'eye',             route: 'Eye',  unit: 'drop', sugg: 'D1', vtm: ['latanoprost'], cls: ['prostaglandin analogue'] },
    { drug: 'Latanoprost / Timolol',  sub: '50 micrograms/ml / 0.5% eye drops (Xalacom)', group: 'eye',   route: 'Eye',  unit: 'drop', sugg: 'D1', vtm: ['latanoprost', 'timolol'], cls: ['prostaglandin analogue', 'beta blocker'] },
    { drug: 'Dorzolamide / Timolol',  sub: '2% / 0.5% eye drops (Cosopt)',       group: 'eye',             route: 'Eye',  unit: 'drop', sugg: 'D1', vtm: ['dorzolamide', 'timolol'], cls: ['carbonic anhydrase inhibitor', 'beta blocker'] },
    { drug: 'Dexamethasone',          sub: '0.1% eye drops (Maxidex)',           group: 'eye',             route: 'Eye',  unit: 'drop', sugg: 'D2', vtm: ['dexamethasone'], cls: ['topical corticosteroid'] },
    { drug: 'Betamethasone',          sub: '0.1% eye drops (Betnesol)',          group: 'eye',             route: 'Eye',  unit: 'drop', sugg: 'D2', vtm: ['betamethasone'], cls: ['topical corticosteroid'] },
    { drug: 'Ciclosporin',            sub: '0.1% eye drops (Ikervis)',           group: 'eye',             route: 'Eye',  unit: 'drop', sugg: 'D3' },
    { drug: 'Chloramphenicol',        sub: '0.5% eye drops',                     group: 'eye',             route: 'Eye',  unit: 'drop', allergy: true },
    { drug: 'Timolol',                sub: '0.5% eye drops',                     group: 'eye',             route: 'Eye',  unit: 'drop', sugg: 'D1', vtm: ['timolol'], cls: ['beta blocker'] },
    { drug: 'Brimonidine',            sub: '0.2% eye drops (Alphagan)',          group: 'eye',             route: 'Eye',  unit: 'drop', sugg: 'D1', vtm: ['brimonidine'], cls: ['alpha agonist'] },
    { drug: 'Tropicamide',            sub: '1% eye drops',                       group: 'eye',             route: 'Eye',  unit: 'drop' },
    { drug: 'Phenylephrine',          sub: '2.5% eye drops',                     group: 'eye',             route: 'Eye',  unit: 'drop' },
    { drug: 'Hypromellose',           sub: '0.3% eye drops',                     group: 'eye',             route: 'Eye',  unit: 'drop', sugg: 'D3' },
    { drug: 'Hypromellose PF',        sub: '0.3% eye drops, unit dose, preservative free', group: 'eye', route: 'Eye', unit: 'drop', pf: true, vtm: ['hypromellose'] },
    { drug: 'Dexamethasone PF',       sub: '0.1% eye drops, unit dose, preservative free', group: 'eye', route: 'Eye', unit: 'drop', pf: true, vtm: ['dexamethasone'], cls: ['topical corticosteroid'] },
    { drug: 'Aflibercept',            sub: '40mg/ml intravitreal injection',     group: 'eye',             route: 'Intravitreal', unit: 'mg' },
    { drug: 'Acetazolamide',          sub: '250mg tablets',                      group: 'systemic-ophth',  route: 'Oral', unit: 'mg', sugg: 'D1', vtm: ['acetazolamide'], cls: ['carbonic anhydrase inhibitor'] },
    { drug: 'Prednisolone',           sub: '5mg tablets',                        group: 'systemic-ophth',  route: 'Oral', unit: 'mg', sugg: 'D2', vtm: ['prednisolone'], cls: ['systemic corticosteroid'] },
    { drug: 'Doxycycline',            sub: '100mg capsules',                     group: 'systemic-ophth',  route: 'Oral', unit: 'mg' },
    { drug: 'Hydroxychloroquine',     sub: '200mg tablets',                      group: 'systemic-other',  route: 'Oral', unit: 'mg', sugg: 'D4', vtm: ['hydroxychloroquine'], cls: ['antimalarial'] },
    { drug: 'Amlodipine',             sub: '5mg tablets',                        group: 'systemic-other',  route: 'Oral', unit: 'mg', sugg: 'D5' },
    { drug: 'Metformin',              sub: '500mg tablets',                      group: 'systemic-other',  route: 'Oral', unit: 'mg', sugg: 'D6' },
    { drug: 'Atorvastatin',           sub: '20mg tablets',                       group: 'systemic-other',  route: 'Oral', unit: 'mg' }
  ];

  var STATE = {
    institution: 'qah',
    /* The event the element is embedded in. Only matters for whether an operated
       eye is available to default a side from. */
    host: 'exam',
    user: 'prescriber',
    seq: 20,
    rxSeq: 1041,
    entries: [],
    artefacts: [],
    /* Transient. Which rows are toggled on for the next order. Never persisted,
       because a stored "to be prescribed" flag is a second source of truth about
       intent and is exactly what gets left set and produces next month's duplicate. */
    selected: [],
    /* Which prescription event is open on the Prescriptions tab, and whether it
       is open for reading or for editing. Opening one for editing moves the
       Medications element inside it: the record is the only place directions are
       written, so a prescriber reconciling an order needs both in one place. */
    rxOpen: null,
    rxMode: 'view',
    rxOnly: false,
    lastChanged: null,
    /* The record as it stood at the last commit. Medication changes are written
       when the event is saved, exactly as Diagnoses 2.0 writes its record event
       inside saveEvent(), so everything since this snapshot exists only here in
       the browser and is invisible to anyone else. */
    committed: [],
    /* What this event changed, once saved. The record event's entries are this
       list, so nothing extra has to be stored to render it. */
    thisEvent: {},
    view: 'record'
  };

  function cloneEntries() { return JSON.parse(JSON.stringify(STATE.entries)); }

  /* Volatile interface state that is not part of the record and must not count
     as an unsaved change. */
  function comparable(e) {
    var c = JSON.parse(JSON.stringify(e));
    delete c.lastLocation; delete c.pendingIndication;
    return JSON.stringify(c);
  }

  /* Pending changes are derived by comparing against the last commit rather than
     flagged at each mutation, so nothing can change the record without showing up. */
  function pendingChanges() {
    var before = {};
    STATE.committed.forEach(function (e) { before[e.id] = comparable(e); });
    var out = [];
    STATE.entries.forEach(function (e) {
      if (!(e.id in before)) { out.push({ id: e.id, kind: 'added', drug: e.drug }); return; }
      if (before[e.id] === comparable(e)) return;
      var was = STATE.committed.filter(function (x) { return x.id === e.id; })[0];
      var kind = (e.status === 'stopped' && was.status !== 'stopped') ? 'stopped' : 'changed';
      out.push({ id: e.id, kind: kind, drug: e.drug });
    });
    return out;
  }
  function pendingKind(id) {
    var p = pendingChanges().filter(function (x) { return x.id === id; })[0];
    return p ? p.kind : null;
  }

  function commitEvent() {
    var p = pendingChanges();
    p.forEach(function (x) { STATE.thisEvent[x.id] = x.kind; });
    STATE.committed = cloneEntries();
    return p;
  }

  /* ------------------------------------------------------------------ seed */

  function seed() {
    STATE.entries = [
      mk({ drug: 'Latanoprost', sub: '50 micrograms/ml eye drops', indication: 'D1', advice: { action: 'hold', anchor: 'before-appt', days: 7, date: '', text: 'Stop using your latanoprost drops 7 days before your next appointment, so the pressure can be measured without treatment. Do not restart until you are told to.', by: 'Mr A Prescriber', at: ts(-14, '10:12'), status: 'awaiting', outcomeNote: '' }, group: 'eye',
           dose: '1', unit: 'drop', freq: 'At night', route: 'Eye', lat: 'Right',
           start: d(-191), supply: 'gp',
           history: [
             h(ts(-191, '09:14'), 'Mr A Prescriber', 'Started', '1 drop, At night, Eye, Right', 'Glaucoma clinic'),
             h(ts(-120, '11:48'), 'Mr A Prescriber', 'Responsibility to supply changed',
               'Hospital to GP. Hospital supply finished, repeats now with the GP', 'Glaucoma clinic')
           ] }),
      /* The same drug in the other eye, on its own thread, stopped. It is here
         because it is the case that breaks a history hung off the drug: the
         right eye is still running, this one was abandoned for intolerance a
         year ago, and neither story is a line in the other's history. */
      mk({ drug: 'Latanoprost', sub: '50 micrograms/ml eye drops', indication: 'D1', group: 'eye',
           dose: '1', unit: 'drop', freq: 'At night', route: 'Eye', lat: 'Left',
           start: d(-540), end: d(-470), status: 'stopped', supply: 'gp',
           stopReason: 'Intolerance: conjunctival hyperaemia',
           history: [
             h(ts(-540, '09:30'), 'Mr A Prescriber', 'Started', '1 drop, At night, Eye, Left', 'Glaucoma clinic'),
             h(ts(-470, '14:05'), 'Mr A Prescriber', 'Stopped', 'Intolerance: conjunctival hyperaemia', 'Glaucoma clinic')
           ] }),
      mk({ drug: 'Dorzolamide / Timolol', sub: '2% / 0.5% eye drops (Cosopt)', indication: 'D1', group: 'eye',
           dose: '1', unit: 'drop', freq: 'Twice daily', route: 'Eye', lat: 'Both',
           start: d(-107), supply: 'gp',
           history: [
             h(ts(-107, '11:02'), 'Mr A Prescriber', 'Started', '1 drop, Twice daily, Eye, Both', 'Glaucoma clinic'),
             h(ts(-60, '09:05'), 'Mr A Prescriber', 'Responsibility to supply changed',
               'Hospital to GP. Hospital supply finished, repeats now with the GP', 'Glaucoma clinic'),
             h(ts(-107, '11:02'), 'Mr A Prescriber', 'Replaced Timolol 0.5%', 'Switched to combination preparation', 'Glaucoma clinic')
           ] }),
      mk({ drug: 'Dexamethasone', sub: '0.1% eye drops (Maxidex)', indication: 'D2', group: 'eye',
           dose: '1', unit: 'drop', freq: 'Four times daily', route: 'Eye', lat: 'Left',
           start: TODAY, duration: '7 days',
           taper: [
             { from: d(7), dose: '1', freq: 'Three times daily', duration: '7 days' },
             { from: d(14), dose: '1', freq: 'Twice daily', duration: '7 days' },
             { from: d(21), dose: '1', freq: 'Once daily', duration: '7 days' }
           ],
           history: [
             h(TODAY + ' 14:20', 'Mr A Prescriber', 'Started', '1 drop, Four times daily, Eye, Left', 'Uveitis clinic'),
             h(TODAY + ' 14:21', 'Mr A Prescriber', 'Course set', 'For 7 days, then 3 reducing steps, finishing 17 Oct 2026', 'Uveitis clinic')
           ] }),
      mk({ drug: 'Ciclosporin', sub: '0.1% eye drops (Ikervis)', group: 'eye',
           dose: '1', unit: 'drop', freq: 'Once daily', route: 'Eye', lat: 'Both',
           start: d(12), supply: 'hospital',
           history: [
             h(TODAY + ' 14:26', 'Mr A Prescriber', 'Planned', 'To start 01 Oct 2026 once steroid course completes', 'Uveitis clinic')
           ] }),
      /* We are starting it and it is ongoing, so it derives GP. Issuing a hospital
         course does not change that: the artefact records what we supplied, and
         the row keeps saying who holds it from here. */
      mk({ drug: 'Acetazolamide', sub: '250mg tablets', indication: 'D1', group: 'systemic-ophth',
           dose: '250', unit: 'mg', freq: 'Twice daily', route: 'Oral', lat: '',
           start: TODAY,
           history: [
             h(TODAY + ' 14:24', 'Mr A Prescriber', 'Started', '250mg, Twice daily, Oral', 'Uveitis clinic')
           ] }),
      /* A reducing course of oral steroid for uveitis is ours to supply and stays
         ours: no GP handover. An explicit value overriding the derived one, which
         is why the row reads it in normal rather than muted text. */
      mk({ drug: 'Prednisolone', sub: '5mg tablets', indication: 'D2', group: 'systemic-ophth',
           dose: '30', unit: 'mg', freq: 'Once daily', route: 'Oral', lat: '',
           start: d(-35), supply: 'hospital',
           history: [
             h(ts(-35, '10:40'), 'Mr A Prescriber', 'Started', '40mg, Once daily, Oral', 'Uveitis clinic'),
             h(ts(-14, '10:15'), 'Mr A Prescriber', 'Changed', '30mg, Once daily, Oral', 'Uveitis clinic')
           ] }),
      /* A hold with both ends recorded. The pause was agreed before surgery and
         the restart was agreed at the same time, so the resume is a planned
         action waiting on an answer rather than something everyone hopes
         somebody remembers. */
      mk({ drug: 'Aspirin', sub: '75mg tablets', group: 'systemic-other',
           dose: '75', unit: 'mg', freq: 'Once daily', route: 'Oral', lat: '',
           start: d(-731), supply: 'gp', existing: true, source: 'gp_letter',
           status: 'held',
           resume: { anchor: 'date', days: 0, date: d(11),
                     text: 'Stop your aspirin on 18 September and start taking it again on 2 October.',
                     by: 'Mr A Prescriber', at: ts(-3, '11:20'), status: 'awaiting', outcomeNote: '' },
           history: [
             h(ts(-731, '00:00'), 'Miss B Nurse', 'Recorded', '75mg, Once daily, Oral. From a GP letter', 'Glaucoma clinic'),
             h(ts(-3, '11:20'), 'Mr A Prescriber', 'Held', 'Paused before surgery', 'Glaucoma clinic'),
             h(ts(-3, '11:20'), 'Mr A Prescriber', 'Resume planned', 'Resume on ' + fmtDate(d(11)) + '. Not yet actioned', 'Glaucoma clinic')
           ] }),
      /* Anchored to the operation rather than to a date, because nobody knew
         the date when it was decided. Inside the operation note this is the one
         drug that has to be answered for today. */
      mk({ drug: 'Clopidogrel', sub: '75mg tablets', group: 'systemic-other',
           dose: '75', unit: 'mg', freq: 'Once daily', route: 'Oral', lat: '',
           start: d(-402), supply: 'gp', existing: true, source: 'gp_letter',
           advice: { action: 'hold', anchor: 'before-surgery', days: 7, date: '',
                     text: 'Stop taking clopidogrel 7 days before your operation. Do not restart until you are told to.',
                     by: 'Mr A Prescriber', at: ts(-28, '15:40'), status: 'awaiting', outcomeNote: '' },
           history: [
             h(ts(-402, '00:00'), 'Miss B Nurse', 'Recorded', '75mg, Once daily, Oral. From a GP letter', 'Glaucoma clinic'),
             h(ts(-28, '15:40'), 'Mr A Prescriber', 'Hold planned',
               'Hold 7 days before the operation, date not known yet. Not yet actioned', 'Glaucoma clinic')
           ] }),
      mk({ drug: 'Hydroxychloroquine', sub: '200mg tablets', indication: 'D4', group: 'systemic-other',
           dose: '200', unit: 'mg', freq: 'Once daily', route: 'Oral', lat: '',
           start: d(-1479), supply: 'gp', existing: true, source: 'shared_care_record',
           history: [ h(ts(-1479, '00:00'), 'Miss B Nurse', 'Recorded', '200mg, Once daily, Oral. From the shared care record', 'Glaucoma clinic') ] }),
      mk({ drug: 'Amlodipine', sub: '5mg tablets', indication: 'D5', group: 'systemic-other',
           dose: '5', unit: 'mg', freq: 'Once daily', route: 'Oral', lat: '',
           start: d(-983), supply: 'gp', existing: true, source: 'patient_reported',
           history: [ h(ts(-983, '00:00'), 'Miss B Nurse', 'Recorded', '5mg, Once daily, Oral. Reported by the patient', 'Glaucoma clinic') ] }),
      mk({ drug: 'Metformin', sub: '500mg tablets', indication: 'D6', group: 'systemic-other',
           dose: '500', unit: 'mg', freq: 'Twice daily', route: 'Oral', lat: '',
           start: d(-1236), supply: 'gp', existing: true, source: 'gp_letter',
           history: [ h(ts(-1236, '00:00'), 'Miss B Nurse', 'Recorded', '500mg, Twice daily, Oral. From a GP letter', 'Glaucoma clinic') ] }),
      /* The reason "Patient" has to exist as a value. This is bought over the
         counter, so it will never appear in the GP record, and without somewhere
         to say so reconciliation would report it as missing at every comparison,
         forever. */
      mk({ drug: 'Hypromellose', sub: '0.3% eye drops', group: 'eye',
           dose: '1', unit: 'drop', freq: 'As required', route: 'Eye', lat: 'Both',
           start: d(-519), supply: 'patient', existing: true, source: 'patient_reported',
           history: [ h(ts(-519, '15:30'), 'Miss B Nurse', 'Recorded', 'Bought over the counter', 'Glaucoma clinic') ] }),
      mk({ drug: 'Timolol', sub: '0.5% eye drops', group: 'eye',
           dose: '1', unit: 'drop', freq: 'Twice daily', route: 'Eye', lat: 'Both',
           start: d(-303), end: d(-107), status: 'stopped', stopReason: 'Not tolerated', supply: '',
           history: [
             h(ts(-303, '09:30'), 'Mr A Prescriber', 'Started', '1 drop, Twice daily, Eye, Both', 'Glaucoma clinic'),
             h(ts(-107, '11:01'), 'Mr A Prescriber', 'Stopped', 'Not tolerated', 'Glaucoma clinic')
           ] })
    ];

    var lat = findByDrug('Latanoprost');
    var cos = findByDrug('Dorzolamide / Timolol');
    STATE.artefacts = [ rx({
      id: 'RX-1041',
      date: d(-107),
      prescriber: 'Mr A Prescriber',
      formType: 'fp10',
      status: 'issued',
      entryIds: [lat.id, cos.id],
      frozen: [ frozenItem(lat, 'fp10'), frozenItem(cos, 'fp10') ],
      signedAt: ts(-107, '11:05'), signedBy: 'Mr A Prescriber',
      signatures: [{ by: 'Mr A Prescriber', at: ts(-107, '11:05'), supersededAt: null, supersededBy: null, reason: null }],
      issuedAt: ts(-107, '11:08'), issuedBy: 'Mr A Prescriber', issueTrigger: 'print',
      printedAt: ts(-107, '11:08'), printedBy: 'Mr A Prescriber', printCount: 1,
      /* An FP10 does not go through hospital pharmacy, so no dispensing roles apply. */
      pharmacy: {}
    }) ];
    STATE.rxSeq = 1041;
  }

  function mk(o) {
    o.id = 'E' + (++STATE.seq);
    o.status = o.status || (o.start > TODAY ? 'planned' : 'current');
    o.taper = o.taper || [];
    o.history = o.history || [];
    if (o.supply === undefined) o.supply = null;
    if (o.supplyProvider === undefined) o.supplyProvider = null;
    if (o.source === undefined) {
      o.source = o.existing ? 'patient_reported' : 'started_here';
    }
    if (o.heldSince === undefined) o.heldSince = null;
    o.indication = o.indication || null;
    o.advice = o.advice || null;
    /* A hold's second end. Undefined means nobody has been asked; null means
       somebody was asked and chose to leave it open, and the row says so. */
    if (o.resume === undefined) o.resume = null;
    /* How the course ends. The stop date is the stored fact; the duration is
       only a note of how it was arrived at. Seed rows may give a duration and let
       the date be worked out once, here, at construction. Nothing recomputes it
       after that. */
    o.duration = o.duration || 'Ongoing';
    if (o.end === undefined) o.end = courseEnd(o.start, o.duration, o.taper);
    /* Set while the change is only in the browser. The record commits with the
       event, so until then this row is not in anyone else's view. */
    o.pending = o.pending || null;
    return o;
  }

  function h(when, who, action, recordedAs, context) {
    return { when: when, who: who, action: action, recordedAs: recordedAs, context: context };
  }

  /* Which event a change was made in. The element is hosted by the examination
     and, in edit mode, by a prescription event, so "Medication record" is not an
     answer: the audit has to name the host. */
  function hostEvent() {
    if (rxEditing()) {
      var a = rxById(STATE.rxOpen);
      return 'Prescription ' + (a ? a.id : '');
    }
    return inOpNote() ? host().label : 'Glaucoma clinic, examination';
  }

  function frozenItem(entry, supply) {
    return {
      entryId: entry.id,
      drug: entry.drug,
      sub: entry.sub,
      supply: supply,
      snapshot: { dose: entry.dose, unit: entry.unit, freq: entry.freq, route: entry.route, lat: entry.lat, taper: entry.taper.slice() }
    };
  }

  function rx(o) {
    o.frozen = o.frozen || null;
    o.requested = o.requested || null;
    o.requestedBy = o.requestedBy || null;
    o.requestedAt = o.requestedAt || null;
    o.requests = o.requests || [];
    o.kept = o.kept || {};
    o.signatures = o.signatures || [];
    o.divergedAt = o.divergedAt || null;
    o.divergedBy = o.divergedBy || null;
    o.formType = o.formType || 'hospital';
    o.locations = o.locations || {};
    o.notes = o.notes || '';
    o.printCount = o.printCount || 0;
    o.pharmacy = o.pharmacy || {};
    o.query = o.query || null;
    o.cancelledAt = o.cancelledAt || null;
    o.cancelReason = o.cancelReason || null;
    o.supersedesId = o.supersedesId || null;
    o.supersededById = o.supersededById || null;
    return o;
  }

  /* ------------------------------------------------------------- utilities */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function findById(id) { return STATE.entries.filter(function (e) { return e.id === id; })[0]; }
  function findByDrug(d) { return STATE.entries.filter(function (e) { return e.drug === d; })[0]; }
  function user() { return USERS[STATE.user]; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function fmtDate(iso) {
    if (!iso) return '';
    var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = iso.split(' ')[0].split('-');
    return parseInt(p[2], 10) + ' ' + m[parseInt(p[1], 10) - 1] + ' ' + p[0];
  }
  function fmtWhen(s) {
    var parts = s.split(' ');
    return fmtDate(parts[0]) + (parts[1] ? ' ' + parts[1] : '');
  }
  function nowStamp() {
    var d = new Date();
    return TODAY + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  /* The same formatter, reading a snapshot rather than a live entry. Both sides of
     a comparison have to be written the same way, or a difference in wording reads
     as a difference in the directions. */
  function snapDirections(s) {
    return directions({ dose: s.dose, unit: s.unit, freq: s.freq, route: s.route, lat: s.lat });
  }

  function directions(e) {
    /* A drug recorded as one the patient walked in on may have no dose and no
       frequency, because we did not ask and should not invent one. Empty parts
       drop out rather than leaving stray commas. */
    var dose = e.dose ? e.dose + (e.unit === 'drop' ? ' drop' + (e.dose === '1' ? '' : 's') : e.unit) : '';
    var bits = [dose, e.freq, e.route];
    if (e.lat) bits.push(e.lat);
    bits = bits.filter(Boolean);
    return bits.length ? bits.join(', ') : 'Dose and frequency not recorded';
  }

  /* Responsibility is offered to everyone and is not gated by institution or by
     prescribing rights, because recording that the GP is responsible for a drug
     is an observation about this patient's care, not an act of prescribing. A
     nurse or an optometrist can state it as well as a consultant can. */
  function supplyOptions() { return RESP_ORDER.slice(); }

  /* Naming the provider is what makes "other" worth having. Without it the value
     says only "not us, not the GP, not the patient", which changes nothing that
     a blank does not already change. */
  /* The name only means anything against "other care provider", so it appears
     with that value and is cleared with it, rather than lingering as a stale
     note beside "GP". */
  function syncProviderField() {
    var wrap = $('#proto-edit-provider-wrap');
    if (wrap) wrap.hidden = btnVal('proto-edit-supply') !== 'other_provider';
  }

  document.addEventListener('change', function (ev) {
    if (ev.target.name === 'p-proto-edit-supply') syncProviderField();
  });

  function supplyLabel(e) {
    var v = effectiveSupply(e);
    if (v === 'other_provider' && e.supplyProvider) return e.supplyProvider;
    return RESPONSIBILITY[v] || v;
  }


  /* Inline change from the Responsibility column. Same history line the Change
     dialog writes, so the two paths are indistinguishable in the audit. */
  function setSupplyInline(e, value) {
    if (!e) return;
    var before = effectiveSupply(e);
    var provider = e.supplyProvider;
    if (value === 'other_provider') {
      if (!provider) {
        provider = window.prompt('Which care provider supplies this?', e.supplyProvider || '') || null;
        if (!provider) { render(); return; }
      }
    } else {
      provider = null;
    }
    if (value === before && provider === (e.supplyProvider || null)) return;
    var wasLabel = supplyLabel(e);
    e.supply = value;
    e.supplyProvider = provider;
    e.history.push(h(nowStamp(), user().name, 'Responsibility to supply changed',
      wasLabel + ' to ' + supplyLabel(e), hostEvent()));
    STATE.lastChanged = e.id;
    render();
  }

  /* Where the order says the GP continues and the row does not already say so,
     ask once. Accepting is a person making a decision; declining leaves the row
     alone. Nothing is rewritten silently. */
  function maybeAdviseGpContinues(a) {
    var c = condById(a.condition);
    if (!c || !c.suggestsGpContinues) return;
    var mismatched = a.entryIds.map(findById).filter(function (e) {
      return e && effectiveSupply(e) !== 'gp' && effectiveSupply(e) !== 'patient'
        && effectiveSupply(e) !== 'other_provider';
    });
    if (!mismatched.length) return;
    var names = mismatched.map(function (e) { return e.drug; }).join(', ');
    alertBox('patient',
      '<strong>This order says the GP continues.</strong> The record currently says '
      + esc(supplyLabel(mismatched[0]))
      + (mismatched.length > 1 ? ' for ' + esc(names) : ' for ' + esc(mismatched[0].drug))
      + '. Update the record?'
      + ' <button type="button" class="proto-btn-confirm" data-act="supply-accept-gp" data-rx="' + a.id + '">Update to GP</button>'
      + ' <button type="button" data-act="supply-decline-gp">Leave as it is</button>');
  }

  function acceptGpContinues(rxId) {
    var a = rxById(rxId);
    if (!a) return;
    a.entryIds.forEach(function (id) {
      var e = findById(id);
      if (!e) return;
      if (effectiveSupply(e) === 'gp' || effectiveSupply(e) === 'patient'
          || effectiveSupply(e) === 'other_provider') return;
      var wasLabel = supplyLabel(e);
      e.supply = 'gp';
      e.supplyProvider = null;
      e.history.push(h(nowStamp(), user().name, 'Responsibility to supply changed',
        wasLabel + ' to GP, on accepting the order advisory for ' + a.id, a.id));
    });
    render();
    alertBox('success', 'Responsibility updated to GP for drugs on ' + esc(a.id) + '.');
  }

  /* Could this drug go on any order here at all? The toggle appears when the
     answer is yes, whether or not this user could sign the result: selecting a
     drug to be ordered is not prescribing, and a nurse selecting a drop for a
     prescriber to sign is the commonest reason drafts exist (OE-17879). A drug
     that can never produce an order still shows nothing, because there is
     nothing to ask for. */
  function canOrder(e) {
    if (e.status === 'stopped') return false;
    return orderableForms(e).length > 0;
  }
  /* Which form types this drug could go on, right now. Gated by the institution's
     conditions, by overprint, and for a PGD by the user's authorisation, which is
     a property of the direction rather than of the paperwork. Note that the row's
     supply responsibility plays no part: a drug the GP normally supplies is still
     orderable today, because ordering is a decision made now, not a property of
     the medication. */
  function orderableForms(e) {
    var i = inst();
    var out = [];
    Object.keys(FORM_TYPES).forEach(function (f) {
      var usable = FORM_TYPES[f].conditions.filter(function (cid) {
        var c = condById(cid);
        if (i.conditions.indexOf(cid) === -1) return false;
        if (c.overprint && !i.overprint) return false;
        if (c.pgd && !pgdForDrug(e.drug)) return false;
        return true;
      });
      if (usable.length) out.push(f);
    });
    return out;
  }
  /* And which of those this user could put their own name to. What is left over
     is the draft path: the same selection, saved as a request for somebody with
     prescribing rights to sign. */
  function canSignForm(f, e) {
    var u = user();
    var i = inst();
    return (FORM_TYPES[f] ? FORM_TYPES[f].conditions : []).some(function (cid) {
      var c = condById(cid);
      if (!c) return false;
      if (i.conditions.indexOf(cid) === -1) return false;
      if (c.overprint && !i.overprint) return false;
      if (c.prescribes && !u.canPrescribe) return false;
      if (c.pgd && !pgdForDrug(e.drug)) return false;
      return true;
    });
  }
  function signableForms(e) {
    return orderableForms(e).filter(function (f) { return canSignForm(f, e); });
  }

  function locationsFor(condId) { var c = condById(condId); return c ? c.locations : ['N/A']; }

  /* Eye relevance. The default comes from the drug's set membership, standing in for
     the Ophthalmic drug set. A per-patient override is stored only when it differs
     from that default, which is the single flag the model proposes. */
  function defaultRelevant(e) {
    // A recorded indication is a better signal than drug-set membership, so it
    // takes over as the default when present. An explicit override still wins.
    var dx = e.indication ? dxById(e.indication) : null;
    if (dx) return dx.eye;
    if (e.group === 'eye') return true;
    /* A systemic drug WE started is relevant by default. An ophthalmologist who
       starts acetazolamide or prednisolone is almost always starting it for the
       eye, so the common case should need no extra click and the rare one is a
       single toggle away. A drug the patient was already on is a different
       matter: it is somebody else's prescription for somebody else's reason, so
       it falls back to drug-set membership, which is usually "not relevant". */
    if (!e.existing) return true;
    return e.group === 'systemic-ophth';
  }

  /* Where the knowledge came from. Stored on the entry at the adder's commit.
     gp_feed is reserved for the reconciliation feed (§R) and cannot be asserted
     by hand. */
  function sourceOf(e) {
    if (e.source && SOURCE[e.source]) return SOURCE[e.source];
    return e.existing ? SOURCE.patient_reported : SOURCE.started_here;
  }
  function sourceKey(e) {
    if (e.source && SOURCE[e.source]) return e.source;
    return e.existing ? 'patient_reported' : 'started_here';
  }

  function isEyeRelevant(e) {
    return e.relevantOverride === null || e.relevantOverride === undefined
      ? defaultRelevant(e)
      : e.relevantOverride;
  }
  function isOverridden(e) { return isEyeRelevant(e) !== defaultRelevant(e); }

  /* ---- advised future actions ----
     Advice is not a state change. The medication carries on until someone confirms
     that the patient acted on it, which is a separate act with its own actor. */


  /* Format locally. toISOString() converts to UTC, which shifts the date back a
     day through British Summer Time and quietly makes every course a day short. */
  function isoOf(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }

  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return isoOf(d);
  }

  /* Resolves to a concrete date only when the anchor can be resolved. An unbooked
     appointment leaves the rule unresolved rather than guessing a date. */
  /* Only a typed date is a date. An action anchored to the next appointment or
     to an operation deliberately does not resolve into one, even when a booking
     exists somewhere in the system, because the booking is the wrong thing to
     trust: clinics are rescheduled, lists move, and a date printed on a patient
     instruction three months ago is worse than no date at all. The anchor is
     stored as the relative instruction it is, the patient is told the relative
     thing, and someone confirms afterwards what actually happened. */
  function adviceDate(a) {
    return a.anchor === 'date' ? (a.date || null) : null;
  }

  /* One vocabulary for both ends of a plan. Surgery and the next appointment
     behave identically: neither has a date we will commit to, and both need
     confirming afterwards. They are separate anchors only because "a week before
     your operation" is what the patient is actually told. */
  var ANCHOR_WORDS = {
    'at-appt':        'at the next appointment',
    'before-appt':    'days before the next appointment',
    'at-surgery':     'on the day of the operation',
    'before-surgery': 'days before the operation'
  };

  function anchorPhrase(anchor, days) {
    if (anchor === 'before-appt' || anchor === 'before-surgery') {
      return (Math.abs(days || 0) || 0) + ' ' + ANCHOR_WORDS[anchor];
    }
    return ANCHOR_WORDS[anchor] || '';
  }

  function anchorIsSurgery(anchor) {
    return anchor === 'at-surgery' || anchor === 'before-surgery';
  }

  function adviceWording(a) {
    var verb = a.action === 'stop' ? 'Stop' : 'Hold';
    if (a.anchor === 'date') return verb + ' on ' + fmtDate(a.date);
    return verb + ' ' + anchorPhrase(a.anchor, a.days) + ', date not known yet';
  }

  /* A hold has two ends and both are planned actions, so the resume is stored
     as its own plan rather than as a field on the hold. It is confirmed the same
     way, and the answer can be no, which is the case worth catching: a patient
     paused for a fortnight and never told to restart is off treatment. */
  function resumeDate(r) {
    if (!r || !r.anchor) return null;
    return r.anchor === 'date' ? (r.date || null) : null;
  }

  function resumeWording(r) {
    if (!r || !r.anchor) return 'Resume to be decided';
    if (r.anchor === 'date') return 'Resume on ' + fmtDate(r.date);
    return 'Resume ' + anchorPhrase(r.anchor, r.days) + ', date not known yet';
  }

  function resumePending(e) {
    return e.resume && e.resume.status === 'awaiting' ? e.resume : null;
  }

  function awaiting() {
    return STATE.entries.filter(function (e) {
      return (e.advice && e.advice.status === 'awaiting') || resumePending(e);
    });
  }

  /* Which group a row appears in. Eye-route drugs are relevant by route and are not
     reclassified here; the override applies to systemic drugs. */
  function displayGroup(e) {
    if (e.group === 'eye') return 'eye';
    return isEyeRelevant(e) ? 'systemic-ophth' : 'systemic-other';
  }

  function rxById(id) { return STATE.artefacts.filter(function (a) { return a.id === id; })[0]; }
  function isLive(a) { return a.status !== 'cancelled'; }
  function isIssued(a) { return a.status === 'issued' || a.status === 'complete'; }
  function isOpen(a) { return a.status === 'draft' || a.status === 'signed'; }
  function isDraft(a) { return a.status === 'draft'; }

  /* What the order says, or would say if it were signed now. Once signed it is the
     snapshot in `frozen` and nothing else. Before that it is read from the record,
     because a signature attests to the record as it stands and never to what
     somebody asked for earlier. What was asked for is held separately, in
     `requested`, and is compared against this rather than substituted for it.
     A drug stopped since the request is not part of the order: prescribing a
     stopped drug needs a positive decision, so the default is to leave it off. */
  function artefactItems(a) {
    if (a.frozen) return a.frozen;
    return a.entryIds.map(function (id) {
      var e = findById(id);
      if (!e || e.status === 'stopped') return null;
      var i = frozenItem(e, a.condition || orderCondition(e, a.formType || 'hospital'));
      i.location = (a.locations && a.locations[e.id]) || null;
      return i;
    }).filter(Boolean);
  }

  /* The artefact currently carrying this medication, cancelled ones excluded.
     A drug can sit on an old issued order and a new one at the same time, so the
     most recent is the one a warning should talk about. */
  function liveArtefactFor(entry) {
    var matches = STATE.artefacts.filter(function (a) {
      return isLive(a) && a.entryIds.indexOf(entry.id) >= 0;
    });
    return matches[matches.length - 1];
  }

  function sameAsSnapshot(e, s) {
    return e.dose === s.dose && e.unit === s.unit && e.freq === s.freq && e.route === s.route && e.lat === s.lat;
  }

  /* Divergence is only meaningful once a snapshot exists, which is from signature
     onwards. An unsigned draft cannot diverge, because it has nothing of its own
     to diverge from. */
  function divergedItems(a) {
    if (!a.frozen) return [];
    return a.frozen.filter(function (i) {
      var e = findById(i.entryId);
      return e && !sameAsSnapshot(e, i.snapshot);
    });
  }

  /* Saving a draft snapshots what was asked for. The copy is evidence of intent
     and nothing more: it is never printed, pharmacy never sees it, and no
     prescriber's name is against it. Saving again rewrites it and keeps the
     version it replaced, so a nurse's original request survives a prescriber
     editing the draft before somebody else signs it. */
  function requestArtefact(a) {
    a.requested = artefactItems(a);
    a.requestedBy = a.requestedBy || user().name;
    a.requestedAt = a.requestedAt || nowStamp();
    a.requests = a.requests || [];
    a.requests.push({ by: user().name, at: nowStamp(), items: a.requested });
  }

  /* What an open draft is read against. A draft that has never been signed is a
     request, so the comparison is with what was asked for. One that has just lost
     its signature is an amendment, and what the prescriber needs to see is what
     they signed. Same component, different baseline. */
  function draftBaseline(a) {
    if (!isDraft(a)) return null;
    var signed = (a.signatures || []).filter(function (s) { return s.items; }).pop();
    if (signed) return { kind: 'signed', items: signed.items, by: signed.by, at: signed.at };
    if (a.requested) return { kind: 'requested', items: a.requested, by: a.requestedBy, at: a.requestedAt };
    return null;
  }

  /* Row by row, does the record still say what the baseline says? The third answer
     is the one the earlier model could only handle by dropping the drug in silence. */
  function draftDiffs(a) {
    var base = draftBaseline(a);
    if (!base) return [];
    return base.items.map(function (i) {
      var e = findById(i.entryId);
      if (!e) return { item: i, kind: 'gone', entry: null };
      if (e.status === 'stopped') return { item: i, kind: 'stopped', entry: e };
      /* A keep covers the version that was kept and nothing later. If the record
         moves again the difference is live again, because otherwise a decision
         about one dose would silently stand for the next one. */
      var kept = a.kept && a.kept[i.entryId];
      if (kept && kept.directions === directions(e) && !sameAsSnapshot(e, i.snapshot)) return { item: i, kind: 'kept', entry: e };
      if (!sameAsSnapshot(e, i.snapshot)) return { item: i, kind: 'changed', entry: e };
      return { item: i, kind: 'same', entry: e };
    });
  }

  /* Restore is not a special mechanism. It writes the requested direction back
     onto the record, in the prescriber's name, where the next person to read the
     record will see it. The alternative, signing directions the record does not
     hold, is exactly what the snapshot exists to prevent. */
  function restoreRequested(a, entryId) {
    var d = draftDiffs(a).filter(function (x) { return x.item.entryId === entryId; })[0];
    if (!d || !d.entry) return null;
    var e = d.entry;
    var s = d.item.snapshot;
    var before = directions(e);
    e.dose = s.dose;
    e.unit = s.unit;
    e.freq = s.freq;
    e.route = s.route;
    e.lat = s.lat;
    e.taper = (s.taper || []).slice();
    if (a.kept) delete a.kept[entryId];
    e.history.push(h(nowStamp(), user().name, 'Changed', directions(e),
      a.id + ': restored the directions requested by ' + (a.requestedBy || 'the person who prepared this draft')
      + '. Record said ' + before));
    return e;
  }

  function outstandingRoles(a) {
    var ft = FORM_TYPES[a.formType] || FORM_TYPES.hospital;
    if (!ft.pharmacy) return [];
    return PHARMACY_ROLES.filter(function (r) { return !a.pharmacy[r]; });
  }

  /* Editing a medication that sits on a signed artefact does NOT change the order.
     The snapshot was taken at signature, so the order still says what was signed.
     What changes is that the record has moved away from it, and three people need
     telling: the prescriber, anyone scanning the timeline, and the pharmacist who
     is next to act. The flag is stored rather than recomputed so the worklist can
     filter on it. */
  function flagDivergence(entry) {
    var flagged = [];
    STATE.artefacts.forEach(function (a) {
      if (!a.frozen || !isLive(a)) return;
      if (a.entryIds.indexOf(entry.id) < 0) return;
      if (!divergedItems(a).length) return;
      if (!a.divergedAt) {
        a.divergedAt = nowStamp();
        a.divergedBy = user().name;
      }
      flagged.push(a.id);
    });
    return flagged;
  }

  /* Signature: the transition that freezes the directions. The snapshot is taken
     here, not at issue, because a signature attests to specific content and there
     has to be a record of what that content was. */
  function signArtefact(a) {
    a.frozen = artefactItems(a);
    a.status = 'signed';
    a.signedAt = nowStamp();
    a.signedBy = user().name;
    /* Responsibility lands here, not when the draft was prepared. Where a
       different prescriber signs an amended order this is the transfer, and it is
       shown rather than implied. */
    a.prescriber = a.signedBy;
    a.divergedAt = null;
    a.divergedBy = null;
    a.kept = {};
    a.signatures = a.signatures || [];
    /* The row carries the content it covered, which is what makes "the signature
       attests to specific content" a true statement rather than an aspiration. */
    a.signatures.push({ by: a.signedBy, at: a.signedAt, items: a.frozen, supersededAt: null, supersededBy: null, reason: null });
  }

  /* Amending a signed order. The artefact is amended in place: same row, same
     number, same notes, same signature history. Nothing is deleted and rebuilt
     from the current record, which is what "void" would imply. This is
     deliberately cheaper than cancelling and far cheaper than a second
     prescription, which is what makes freezing at signature affordable. */
  function dropSignature(a, reason) {
    var last = (a.signatures || [])[a.signatures.length - 1];
    if (last && !last.supersededAt) {
      last.supersededAt = nowStamp();
      last.supersededBy = user().name;
      last.reason = reason || 'Amended before issue';
    }
    a.status = 'draft';
    a.frozen = null;
    a.signedAt = null;
    a.signedBy = null;
    a.divergedAt = null;
    a.divergedBy = null;
  }

  /* Issue: release. Triggered by printing, or by the first pharmacy signature,
     whichever happens first. The directions are already frozen by then. */
  function issueArtefact(a, trigger) {
    if (!a.frozen) a.frozen = artefactItems(a);
    a.status = 'issued';
    a.issuedAt = nowStamp();
    a.issuedBy = user().name;
    a.issueTrigger = trigger;
    /* Issuing never changes responsibility to supply. The row and the artefact
       are two layers: the artefact says what we supplied, the row says who holds
       it from here. A human moves the row; the system does not. */
    commitEvent();
  }


  /* ------------------------------------------------------------- rendering */

  /* Two different markers. "Not yet saved" is about the commit boundary and
     clears on save. "Changed at this visit" is durable and is what the saved
     view shows. Conflating them would hide the one that matters. */
  /* The bar carries both kinds of unsaved thing: edits to the record, and an
     order the element is holding. They leave together, on one save, because
     they are one act of clinical work and an order generated from a record the
     save might still reject is the hazard the whole arrangement avoids. */
  function renderCommitBar() {
    var p = pendingChanges();
    var bar = $('#proto-commit-bar');
    bar.hidden = !p.length && !rxIntent;
    if (bar.hidden) return;
    var text = '';
    if (p.length) {
      var counts = { added: 0, changed: 0, stopped: 0 };
      p.forEach(function (x) { counts[x.kind]++; });
      var parts = [];
      if (counts.added) parts.push(counts.added + ' added');
      if (counts.changed) parts.push(counts.changed + ' changed');
      if (counts.stopped) parts.push(counts.stopped + ' stopped');
      text = '<strong>' + p.length + ' change' + (p.length === 1 ? '' : 's')
        + ' not yet saved</strong> (' + parts.join(', ')
        + '). Nothing here is in the record, or visible to anyone else, until the examination is saved.';
    }
    if (rxIntent) {
      var label = formPhrase(rxIntent.form);
      text += (text ? ' ' : '')
        + '<strong>' + esc(formPhraseA(rxIntent.form)).replace(/^a/, 'A') + ' is waiting on this element</strong>, '
        + (rxIntent.mode === 'sign'
            ? 'signed by ' + esc(rxIntent.by) + '. It is generated, numbered and printable when you save.'
            : 'chosen as a request for a prescriber. It is created when you save.');
    }
    $('#proto-commit-text').innerHTML = text;
  }

  function render() {
    checkRxeIntent();
    computeRxDiffMap();
    renderCommitBar();
    renderReconcile();
    renderGroup('eye');
    renderGroup('systemic-ophth');
    renderGroup('systemic-other');
    renderStopped();
    renderCollapseCounts();
    renderPrescribeBar();
    renderArtefacts();
    $('#proto-btn-pgd').hidden = myPgds().length === 0;
    $('#proto-institution').value = STATE.institution;
    $('#proto-user-name').textContent = user().name;
    STATE.lastChanged = null;
  }

  /* The reconciliation prompt. Advice that nobody has closed is the failure mode
     worth designing against, so it sits above the record rather than inside a row. */
  /* Drugs held for an operation, seen from inside the operation note. Anchoring
     a hold to surgery names the day it has to be answered, and that day is this
     one. Everywhere else a planned action is confirmed and the restart is then
     arranged as a second act; here the two are the same thought, so each button
     does both at once. Leaving a drug held with nobody owning the restart is the
     failure this exists to prevent. */
  function surgeryHolds() {
    if (!inOpNote()) return [];
    return STATE.entries.filter(function (e) {
      return e.advice && e.advice.status === 'awaiting' && anchorIsSurgery(e.advice.anchor);
    });
  }

  function inOpNote() { return String(STATE.host || '').indexOf('op') === 0; }

  function renderSurgeryBand() {
    var held = surgeryHolds();
    if (!held.length) return '';
    return '<div class="alert-box patient proto-reconcile proto-surgery-band">'
      + '<strong>Held for this operation. Confirm, and say when it restarts.</strong> '
      + (held.length === 1 ? 'One drug was' : held.length + ' drugs were')
      + ' due to be held for today\u2019s operation. Nothing yet says whether that happened, or when it goes back on. '
      + 'One button answers both.'
      + '<ul class="proto-reconcile-list">'
      + held.map(function (e) {
          var a = e.advice;
          return '<li><span class="proto-strong">' + esc(e.drug) + '</span> &mdash; ' + esc(adviceWording(a))
            + '. Planned by ' + esc(a.by) + ' on ' + esc(fmtWhen(a.at))
            + '<span class="proto-surgery-acts">'
            + opBtn(e, 'today', 'Held, restart today')
            + opBtn(e, '7', 'Held, restart in 7 days')
            + opBtn(e, 'open', 'Held, restart to be decided')
            + opBtn(e, 'no', 'Not held')
            + '</span></li>';
        }).join('')
      + '</ul></div>';
  }

  function opBtn(e, plan, label) {
    return '<button type="button" class="proto-btn-confirm" data-act="op-hold" data-id="'
      + e.id + '" data-plan="' + plan + '">' + esc(label) + '</button> ';
  }

  /* One click records the confirmation and the restart together, then says in
     words what both of them were, because a button that does two things has to
     account for both. */
  function resolveSurgeryHold(e, plan) {
    var a = e.advice;
    a.outcomeNote = '';
    a.resolvedBy = user().name;
    a.resolvedAt = nowStamp();
    var msg;

    if (plan === 'no') {
      a.status = 'not-done';
      e.history.push(h(a.resolvedAt, a.resolvedBy, 'Planned change not done',
        'Not held for the operation', hostEvent()));
      msg = '<strong>' + esc(e.drug) + '</strong> recorded as not held. The record is unchanged, and the fact '
        + 'that the hold did not happen is now on it.';
    } else {
      a.status = 'done';
      e.status = 'held';
      e.heldSince = TODAY;
      e.history.push(h(a.resolvedAt, a.resolvedBy, 'Confirmed held',
        'Held for the operation on ' + fmtDate(TODAY), hostEvent()));

      if (plan === 'today') {
        e.status = 'current';
        e.resume = null;
        e.history.push(h(a.resolvedAt, a.resolvedBy, 'Resumed',
          'Restarted after the operation, same day', hostEvent()));
        msg = '<strong>' + esc(e.drug) + '</strong> confirmed held for the operation and restarted today. '
          + 'Both are on the record, so nothing is left waiting on an answer.';
      } else if (plan === 'open') {
        setResumePlan(e, null, '');
        msg = '<strong>' + esc(e.drug) + '</strong> confirmed held, with the restart left undecided. '
          + 'The row says so, which is what makes an open-ended hold findable later.';
      } else {
        var days = parseInt(plan, 10);
        setResumePlan(e, { anchor: 'date', days: 0, date: addDays(TODAY, days) },
          'Start taking ' + e.drug.toLowerCase() + ' again on ' + fmtDate(addDays(TODAY, days)) + '.', TODAY);
        msg = '<strong>' + esc(e.drug) + '</strong> confirmed held, restarting ' + fmtDate(addDays(TODAY, days))
          + '. That restart is a planned action, so somebody will be asked to confirm it happened.';
      }
    }
    STATE.lastChanged = e.id;
    render();
    alertBox('', msg);
  }

  function renderReconcile() {
    var due = awaiting().filter(function (e) { return surgeryHolds().indexOf(e) === -1; });
    var box = $('#proto-reconcile');
    var html = renderSurgeryBand();
    if (due.length) {
      html += '<div class="alert-box patient proto-reconcile">'
        + '<strong>Planned changes awaiting confirmation.</strong> '
        + 'These were planned at an earlier visit. Nobody has recorded whether they happened, so the record still '
        + 'shows them as being taken.'
        + '<ul class="proto-reconcile-list">'
        + due.map(function (e) {
            var p = (e.advice && e.advice.status === 'awaiting')
              ? { kind: 'advice', words: adviceWording(e.advice), by: e.advice.by, at: e.advice.at }
              : { kind: 'resume', words: resumeWording(e.resume), by: e.resume.by, at: e.resume.at };
            return '<li><span class="proto-strong">' + esc(e.drug) + '</span> &mdash; ' + esc(p.words)
              + '. Planned by ' + esc(p.by) + ' on ' + esc(fmtWhen(p.at))
              + ' <button type="button" class="proto-btn-confirm" data-act="confirm" data-id="' + e.id
              + '" data-kind="' + p.kind + '">Confirm</button></li>';
          }).join('')
        + '</ul></div>';
    }
    /* An unsigned request goes in the same band, because both lines answer one
       question: what is outstanding on this patient's medications. The hazard is
       the quiet one, where a nurse leaves the clinic believing a prescription was
       arranged and nobody ever signed it. A queue addressed to named prescribers
       is a different workflow and is deliberately not here. */
    var pendingRx = STATE.artefacts.filter(function (a) { return isDraft(a) && a.requestedBy && !a.signatures.length; });
    if (pendingRx.length) {
      html += '<div class="alert-box patient proto-reconcile">'
        + '<strong>Prescription requested and not yet signed.</strong> '
        + 'The drugs are on the record; what is missing is a signature.'
        + '<ul class="proto-reconcile-list">'
        + pendingRx.map(function (a) {
            return '<li><span class="proto-strong">' + esc(a.id) + '</span> &mdash; '
              + esc(artefactItems(a).map(function (i) { return i.drug; }).join(', ') || 'nothing still orderable')
              + '. Requested by ' + esc(a.requestedBy) + ' on ' + esc(fmtWhen(a.requestedAt))
              + ' <button type="button" class="proto-btn-confirm" data-act="tab" data-tab="artefacts">Open</button></li>';
          }).join('')
        + '</ul></div>';
    }
    box.innerHTML = html;
  }

  function renderGroup(group) {
    var tbody = $('#tbody-' + group);
    var rows = STATE.entries.filter(function (e) { return displayGroup(e) === group && e.status !== 'stopped'; });
    /* Inside a prescription event the reader can narrow the list to the drugs on
       that order. It is a filter over the same rows, never a different list. */
    var rxe = rxEditing();
    if (rxe && STATE.rxOnly) {
      rows = rows.filter(function (e) { return rxe.entryIds.indexOf(e.id) >= 0; });
    }
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="proto-empty">None recorded</div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(rowHtml).join('');
  }

  /* The count goes in the header so a collapsed section still says how much is
     behind it. A section that hides an unknown quantity is one nobody opens. */
  /* Every group carries its count in the heading, the way IDG shows "Eye (99)",
     so a collapsed group still says how much is behind it. */
  function renderCollapseCounts() {
    var counts = { eye: 0, 'systemic-ophth': 0, 'systemic-other': 0, stopped: 0 };
    STATE.entries.forEach(function (e) {
      if (e.status === 'stopped') counts.stopped++;
      else counts[displayGroup(e)]++;
    });
    Object.keys(counts).forEach(function (g) {
      var el = $('#group-' + g + ' .proto-count');
      if (el) el.textContent = counts[g];
    });
  }

  function renderStopped() {
    var tbody = $('#tbody-stopped');
    var rows = STATE.entries.filter(function (e) { return e.status === 'stopped'; });
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="proto-empty">None</div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (e) {
      return '<tr class="proto-row is-stopped" data-id="' + e.id + '">'
        + '<td><span class="proto-drug-name">' + esc(e.drug) + '</span><span class="proto-drug-sub">' + esc(e.sub) + '</span></td>'
        + '<td class="proto-lat">' + latIcon(e) + '</td>'
        + '<td class="proto-directions">' + esc(directions(e)) + '</td>'
        + '<td class="proto-dates"><span class="proto-date-range">' + fmtDate(e.start)
        +   '<i class="proto-date-arrow">&rarr;</i>' + fmtDate(e.end) + '</span></td>'
        + '<td colspan="2">' + esc(e.stopReason || '') + '</td>'
        + '<td class="proto-actions">'
        +   '<button type="button" data-act="history" data-id="' + e.id + '">History</button> '
        +   '<button type="button" data-act="restart" data-id="' + e.id + '">Restart</button>'
        + '</td></tr>';
    }).join('');
  }

  function rowHtml(e) {
    var cls = 'proto-row';
    if (e.status === 'planned') cls += ' is-planned';
    if (e.status === 'held') cls += ' is-held';
    if (STATE.lastChanged === e.id) cls += ' just-changed';

    var pend = pendingKind(e.id);
    if (pend) cls += ' is-unsaved';

    /* OpenEyes states things with icons and one highlighter class, not a row of
       coloured pills. Anything a glyph can say, a glyph says: a clock for a drug
       that has not started, a taper icon for a reducing course, an Rx icon with
       the order number. The highlighter is reserved for the two states a reader
       has to act on, which are an unsaved change and a planned action still
       waiting on the patient. */
    var tags = '';
    if (pend) {
      tags += '<span class="highlighter orange">'
        + (pend === 'added' ? 'Added' : pend === 'stopped' ? 'Stopped' : 'Changed')
        + ', not saved</span> ';
    } else if (STATE.thisEvent[e.id]) {
      tags += '<span class="highlighter subtle-invert">'
        + (STATE.thisEvent[e.id] === 'added' ? 'Started' : 'Changed') + ' at this visit</span> ';
    }
    if (e.status === 'planned') {
      /* The DA review asked for future-dated drugs to look as different from
         current medication as possible. Three marks rather than one: the row
         goes grey and italic including the laterality icons (CSS .is-planned),
         the start date is stated in words rather than left to the date column,
         and the tooltip says in plain terms that the patient is not taking it. */
      tags += '<span class="highlighter subtle-invert proto-planned-tag">Not started</span> '
        + '<i class="oe-i clock small pad-r no-click" title="Not being taken yet. Starts '
        + esc(fmtDate(e.start)) + '."></i>';
    }
    if (e.status === 'held') {
      tags += '<i class="oe-i waiting small pad-r no-click" title="On hold"></i>';
    }
    /* Eye relevance is already said by which group the row is in, so it is only
       marked when a person has overridden the default and the group is therefore
       not self-explanatory. */
    if (isOverridden(e)) {
      tags += '<i class="oe-i ' + (isEyeRelevant(e) ? 'eye' : 'd-slash')
        + ' small pad-r no-click" title="Relevance set by hand: '
        + (isEyeRelevant(e) ? 'relevant to eye care' : 'not relevant to eye care') + '"></i>';
    }
    if (e.taper.length) {
      tags += '<i class="oe-i taper small pad-r no-click" title="Reducing course"></i>';
    }
    if (e.advice && e.advice.status === 'awaiting') {
      tags += '<span class="highlighter">'
        + (e.advice.action === 'stop' ? 'Stop planned' : 'Hold planned') + '</span> ';
    }
    if (resumePending(e)) {
      tags += '<span class="highlighter">Resume planned</span> ';
    }

    var rxa = liveArtefactFor(e);
    if (rxa) {
      tags += '<span class="proto-rx-ref' + (isIssued(rxa) ? ' is-issued' : '') + '">'
        + '<i class="oe-i drug-rx small no-click"></i>' + esc(rxa.id)
        + (isIssued(rxa) ? '' : ' <span class="fade">' + esc(ARTEFACT_STATES[rxa.status].label.toLowerCase()) + '</span>')
        + '</span> ';
    }

    var dates = datesHtml(e);

    var last = e.history[e.history.length - 1];
    var attrib = last ? last.who + ', ' + fmtWhen(last.when) : '';

    /* Responsibility to supply is the control itself: click the cell, pick from
       the four, done. Muted text means nobody has set it and the row is showing
       the default. Issuing never changes this. */
    var supplyIsSet = !(e.supply === null || e.supply === undefined);
    var curSupply = effectiveSupply(e);
    var sel = '<select class="proto-supply-select' + (supplyIsSet ? '' : ' is-derived')
      + '" data-act="supply" data-id="' + e.id + '" title="'
      + (supplyIsSet ? 'Set on this record' : 'Default; change it here or in the Change dialog') + '">'
      + RESP_ORDER.filter(function (o) { return o !== ''; }).map(function (o) {
          return '<option value="' + o + '"' + (o === curSupply ? ' selected' : '') + '>'
            + esc(RESPONSIBILITY[o]) + '</option>';
        }).join('')
      + '</select>'
      + (curSupply === 'other_provider' && e.supplyProvider
          ? '<span class="proto-supply-note">' + esc(e.supplyProvider) + '</span>' : '');

    /* Source is its own fact and no longer shares this line with the supply note. */
    var supplyNote = 'Source: ' + sourceOf(e);
    if (rxa && isIssued(rxa)) supplyNote += ' · On issued order ' + rxa.id;
    else if (rxa) supplyNote += ' · On ' + rxa.id + ', not yet issued';

    /* The toggle is a selection, never a stored field. It appears only where this
       user could actually generate something for this drug. Inside a prescription
       event it means something narrower and is labelled as such: on this order,
       or not on it. */
    var rxe = rxEditing();
    var toggle = '';
    if (rxe) {
      var onOrder = rxe.entryIds.indexOf(e.id) >= 0;
      var fits = canOrder(e) && orderableForms(e).indexOf(rxe.formType) >= 0;
      if (onOrder || fits) {
        toggle = '<label class="proto-toggle" title="On ' + esc(rxe.id) + '">'
          + '<input type="checkbox" data-act="rxitem" data-id="' + e.id + '"'
          + (onOrder ? ' checked' : '') + '>'
          + '<span class="proto-toggle-track"><span class="proto-toggle-knob"></span></span></label>';
      } else if (canOrder(e)) {
        toggle = '<span class="proto-drug-sub" title="This order is '
          + esc((FORM_TYPES[rxe.formType] || {}).label || '') + '">not on this form</span>';
      }
    } else if (canOrder(e)) {
      toggle = '<label class="proto-toggle" title="Include in the next order">'
        + '<input type="checkbox" data-act="rxsel" data-id="' + e.id + '"'
        + (STATE.selected.indexOf(e.id) >= 0 ? ' checked' : '') + '>'
        + '<span class="proto-toggle-track"><span class="proto-toggle-knob"></span></span></label>';
    }

    /* The same difference the order is showing, marked where the editing happens.
       A prescriber should not have to hold two screens in their head to see that
       the dose in front of them is not the dose that was asked for. */
    var rxd = rxe ? rxDiffMap[e.id] : null;
    var rxMark = '';
    if (rxd) {
      rxMark = '<span class="proto-rx-diffmark">'
        + (rxd.kind === 'kept' ? 'Kept, differs from ' : 'Differs from ')
        + esc(rxd.baseKind === 'requested' ? 'what was requested' : 'what was signed')
        + ': ' + esc(snapDirections(rxd.item.snapshot)) + '</span>';
    }

    var dx = e.indication ? dxById(e.indication) : null;

    if (rxd && rxd.kind !== 'kept') cls += ' proto-rx-diffrow';
    if (rxe && rxe.entryIds.indexOf(e.id) >= 0) cls += ' proto-rx-onorder';

    return '<tr class="' + cls + '" data-id="' + e.id + '">'
      + '<td><span class="proto-drug-name">' + esc(e.drug) + '</span>'
      +   '<span class="proto-drug-sub">' + esc(e.sub) + '</span>'
      +   (dx ? '<span class="proto-drug-sub proto-for">for ' + esc(dx.name) + '</span>' : '')
      +   '</td>'
      + '<td class="proto-lat">' + latIcon(e) + '</td>'
      + '<td class="proto-directions">' + tags + '<br>' + esc(directions(e))
      +   (e.taper.length ? '<span class="proto-drug-sub">then ' + e.taper.map(function (t) { return esc(t.freq) + ' from ' + fmtDate(t.from); }).join(', ') + '</span>' : '')
      +   (e.advice && e.advice.status === 'awaiting'
            ? '<span class="proto-advice-line">Not '
              + (e.advice.action === 'stop' ? 'stopped' : 'held') + ' yet. '
              + esc(adviceWording(e.advice)) + '.</span>' : '')
      +   (resumePending(e)
            ? '<span class="proto-advice-line">'
              + (e.status === 'held' ? heldWording(e) + ' ' : '')
              + esc(resumeWording(e.resume)) + '. Not restarted yet.</span>'
            : (e.status === 'held' && e.resume === null
                ? '<span class="proto-advice-line">' + heldWording(e) + ' Resume to be decided.</span>' : ''))
      +   rxMark
      +   '<span class="proto-attrib">' + esc(attrib) + '</span></td>'
      + '<td class="proto-dates">' + dates + '</td>'
      + '<td class="proto-supply">' + sel + '<span class="proto-supply-note">' + esc(supplyNote) + '</span></td>'
      + '<td class="proto-rxsel">' + toggle + '</td>'
      + '<td class="proto-actions">'
      +   '<button type="button" data-act="edit" data-id="' + e.id + '">Change</button> '
      +   (e.group === 'eye' ? ''
            : '<button type="button" data-act="relevance" data-id="' + e.id + '">'
              + (isEyeRelevant(e) ? 'Not eye relevant' : 'Eye relevant') + '</button> ')
      +   (e.advice && e.advice.status === 'awaiting'
            ? '<button type="button" class="proto-btn-confirm" data-act="confirm" data-id="' + e.id + '" data-kind="advice">Confirm</button> '
            : (resumePending(e)
                ? '<button type="button" class="proto-btn-confirm" data-act="confirm" data-id="' + e.id + '" data-kind="resume">Confirm</button> '
                : ''))
      +   '<button type="button" data-act="hold" data-id="' + e.id + '">' + (e.status === 'held' ? 'Resume' : 'Hold') + '</button> '
      +   '<button type="button" data-act="stop" data-id="' + e.id + '">Stop</button> '
      +   '<button type="button" data-act="history" data-id="' + e.id + '">History</button>'
      + '</td></tr>';
  }

  /* OpenEyes already has one laterality control, oe-lat, and it draws both eyes
     at once: the side that applies is coloured, the side that does not is a grey
     dash. That is why there is no "Both" pill here. Two marks in a fixed position
     can be read down a column without reading any words, and a bilateral drug
     looks like a bilateral drug rather than like a word that has to be parsed.
     Systemic drugs get the person glyph, so the column means something on every
     row and the four tables still line up. */
  function latIcon(e) {
    if (e.route !== 'Eye') return '<i class="oe-lat sys" title="Systemic"></i>';
    var cls = e.lat === 'Right' ? 'R-n' : e.lat === 'Left' ? 'n-L' : e.lat === 'Both' ? 'R-L' : 'Rq-Lq';
    var title = e.lat ? e.lat : 'Side not recorded';
    return '<i class="oe-lat ' + cls + '" title="' + title + '"></i>';
  }

  /* One line, start arrow end, which is how the rest of OpenEyes writes a course
     and how the earlier design drew it. "Ongoing" sits in the end slot rather
     than being an absence, so an open-ended drug and a finite one are read the
     same way. An anchored stop has no date yet and says so. */
  function datesHtml(e) {
    var from = fmtDate(e.start);
    var to;
    if (e.anchorDays !== null && e.anchorDays !== undefined) {
      to = '<span class="proto-date-soft">' + e.anchorDays + 'd before next appt</span>';
    } else if (lastTaperEnd(e)) {
      to = fmtDate(lastTaperEnd(e));
    } else {
      to = '<span class="proto-date-soft">Ongoing</span>';
    }
    return '<span class="proto-date-range">' + from
      + '<i class="proto-date-arrow">&rarr;</i>' + to + '</span>';
  }

  /* The stored date, not a recomputation. The row must show what is in the
     record, otherwise the record and the screen can disagree. */
  function lastTaperEnd(e) {
    return e.end || '';
  }

  /* The selected rows, filtered to those still orderable. Selection is cleared
     when an order is generated, so it cannot linger between visits. */
  function selectedEntries() {
    return STATE.selected.map(findById).filter(function (e) { return e && canOrder(e); });
  }

  /* One button per form type, so the form is chosen once for the whole order
     rather than per drug. A form is offered when at least one selected drug
     could go on it. */
  /* The prescribe controls belong to the element, not to the window. OpenEyes
     does not use bars stuck to the bottom of the screen, and the action is
     specific to this element, so it sits inside it, repeated top and bottom so
     it is reachable from either end of a long list. It is not there at all until
     something is selected, which keeps the element quiet in the common case.

     The form is a radio rather than one button per form, because the form is
     chosen once for the whole order.

     Nothing in this bar creates anything. A PIN signs the element, and choosing
     the draft box marks the element; either way what is left behind is an
     intention held on the element, which the examination save acts on. That is
     how every other signed element in OpenEyes behaves, and it is the only
     arrangement in which an order cannot exist for an examination that was
     never saved. */
  function renderPrescribeBar() {
    checkRxIntent();
    var sel = selectedEntries();
    var bars = $$('.proto-rx-bar');

    /* Inside a prescription event the element does not offer to start a second
       order. There is one thing to sign on the screen and it is the order above,
       so the signing controls live on it rather than being repeated here. */
    if (!sel.length || STATE.view !== 'record' || rxEditing()) {
      bars.forEach(function (b) { b.hidden = true; });
      return;
    }

    var forms = {};
    sel.forEach(function (e) { orderableForms(e).forEach(function (f) { forms[f] = (forms[f] || 0) + 1; }); });
    var names = Object.keys(FORM_TYPES).filter(function (f) { return forms[f]; });
    if (rxForm && names.indexOf(rxForm) === -1) rxForm = null;
    if (!rxForm) rxForm = names[0] || null;

    /* Whether a PIN field appears follows the form, not just the user. A nurse who
       has selected a drug one of her PGDs covers sees both of her options on the
       one bar: the PGD supply she can sign herself, and the hospital order she can
       only ask for. Nothing is greyed out, so the limit is legible before the work
       rather than in a popup afterwards (OE-17879, OE-17893). */
    var included = sel.filter(function (e) { return rxForm && orderableForms(e).indexOf(rxForm) >= 0; });
    var canSign = included.length > 0 && included.every(function (e) { return canSignForm(rxForm, e); });

    bars.forEach(function (bar) {
      bar.hidden = false;
      bar.querySelector('.proto-rx-count').textContent = sel.length + ' selected for order:';
      bar.querySelector('.proto-rx-names').textContent = sel.map(function (e) { return e.drug; }).join(', ');
      bar.querySelector('.proto-rx-forms').innerHTML = names.map(function (f) {
        var n = forms[f];
        return '<label class="highlight as-button inline"><input type="radio" data-rx-form="1" name="proto-rx-form-'
          + bar.id + '" value="' + f + '"'
          + (rxForm === f ? ' checked' : '') + '><span class="btn">' + esc(FORM_TYPES[f].label)
          + (n < sel.length ? ' (' + n + ' of ' + sel.length + ')' : '') + '</span></label>';
      }).join('');
      var signed = rxIntent && rxIntent.mode === 'sign';
      var drafted = rxIntent && rxIntent.mode === 'draft';
      var label = esc(formPhrase(rxForm));

      var opt = bar.querySelector('.proto-rx-opt');
      opt.hidden = signed;
      opt.classList.toggle('selected', !!drafted);
      opt.setAttribute('aria-pressed', drafted ? 'true' : 'false');
      bar.querySelector('.proto-rx-pin').value = '';
      bar.querySelector('.proto-pin-wrap').hidden = signed || drafted || !canSign;

      var sig = bar.querySelector('.proto-rx-signed');
      sig.hidden = !signed;
      if (signed) {
        sig.innerHTML = SIGNATURE_SVG
          + '<span class="proto-sig-meta"><i class="oe-i tick-green small pad-right"></i>Signed <small>at</small> '
          + esc(rxIntent.at.slice(11)) + ' <small>by</small> ' + esc(rxIntent.by) + '</span>'
          + '<button type="button" class="proto-sig-clear" data-rx-opt="clear">Remove</button>';
      }

      var note = bar.querySelector('.proto-rx-note');
      note.hidden = canSign && !rxIntent;
      if (signed) {
        note.innerHTML = 'The ' + label + ' is generated when the examination is saved. '
          + 'Any further change to this list takes the signature off, because it attests to the list '
          + 'as it stands now.';
      } else if (drafted) {
        note.innerHTML = 'Chosen: a request for a prescriber to sign. The ' + label
          + ' is created when the examination is saved, holding what you asked for, and whoever signs it '
          + 'sees that beside the record as it then stands.'
          + (canSign ? ' Unpick the box to sign it yourself instead.' : '');
      } else if (!canSign) {
        note.innerHTML = 'You cannot sign ' + esc(formPhraseA(rxForm))
          + ', so your route is to ask for one: pick the box, then save the examination. It records what '
          + 'you asked for, and whoever signs it sees that beside the record as it then stands.';
      }
    });
  }

  var rxForm = null;
  /* What the element is holding: a signature, or a decision to ask for one.
     Neither is an artefact. Both are discarded with the examination. */
  var rxIntent = null;
  /* The same thing one level down, for an order being edited inside its own
     prescription event. A PIN there signs that order when the event is saved. */
  var rxeIntent = null;
  /* Which rows differ from what this order holds, recomputed each render. */
  var rxDiffMap = {};

  /* The order open for editing, or null. Everything the element does differently
     inside a prescription event hangs off this one answer. */
  function rxEditing() {
    if (!STATE.rxOpen || STATE.rxMode !== 'edit') return null;
    var a = rxById(STATE.rxOpen);
    return a && isOpen(a) ? a : null;
  }

  /* A hand-drawn mark rather than a tick or a padlock, because the point of the
     signed state is that it reads at a glance as the same thing a paper
     prescription carries. */
  var SIGNATURE_SVG = '<svg class="proto-sig-mark" viewBox="0 0 120 30" aria-hidden="true">'
    + '<path d="M4 23c6-1 11-6 13-12s0-8-3-6-2 11 2 15 8 2 11-3 4-9 6-9 2 7 5 8 6-3 8-6 5-2 6 2 2 5 4 4 5-4 8-6 7-2 10 0" '
    + 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    + '<path d="M78 27c8 0 24-2 38-6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/>'
    + '</svg>';

  /* A signature covers the list as it stood when it was given, so anything that
     moves the list, the selection, the form or the user takes it off. Deciding
     which edits are relevant enough to matter is exactly the inference that ends
     with a signature standing over something its signer never saw. A draft
     choice survives an edit, because it attests to nothing: it only says what
     the save should do, and what is asked for is read at the save. */
  function rxFingerprint() {
    return JSON.stringify({
      user: STATE.user, form: rxForm,
      sel: STATE.selected.slice().sort(),
      rows: STATE.entries.map(comparable)
    });
  }

  function checkRxIntent() {
    if (!rxIntent) return;
    if (!STATE.selected.length) { rxIntent = null; return; }
    if (rxIntent.mode !== 'sign' || rxIntent.fp === rxFingerprint()) return;
    rxIntent = null;
    alertBox('patient', '<strong>Signature removed.</strong> The list changed after it was signed, so the '
      + 'element is unsigned again and the PIN field is back. Nothing was generated: a prescription only '
      + 'exists once the examination is saved with a signature standing on it.');
  }

  function setRxIntent(mode) {
    rxIntent = { mode: mode, form: rxForm, at: nowStamp(), by: user().name, fp: null };
    rxIntent.fp = rxFingerprint();
  }

  /* Opening one prescription event, or going back to the list. */
  document.addEventListener('change', function (ev) {
    if (ev.target.id === 'proto-rx-pick') {
      openRx(ev.target.value || null, 'view');
      return;
    }
    if (ev.target.dataset && ev.target.dataset.act === 'rx-only') {
      STATE.rxOnly = ev.target.checked;
      render();
      return;
    }
    /* A drug going on or off the order it is being edited from. */
    if (ev.target.dataset && ev.target.dataset.act === 'rxitem') {
      rxSetItem(ev.target.dataset.id, ev.target.checked);
      return;
    }
  });

  /* The PIN on the order being edited. Same rule as the element: it signs, and
     the save is what turns the signature into a signed order. */
  document.addEventListener('input', function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains('proto-rxe-pin')) return;
    var a = rxEditing();
    if (!a || ev.target.value.length < 6) return;
    ev.target.value = '';
    rxeIntent = { mode: 'sign', rx: a.id, by: user().name, at: nowStamp(), fp: rxeFingerprint(a) };
    render();
    alertBox('', '<strong>Signed by ' + esc(user().name) + '.</strong> '
      + esc(a.id) + ' becomes a signed order when you save this prescription.');
  });

  document.addEventListener('change', function (ev) {
    if (ev.target.dataset && ev.target.dataset.rxForm) {
      rxForm = ev.target.value;
      /* Changing the form changes what is being asked for, so a choice already
         made is re-read against the new one rather than carried over silently. */
      if (rxIntent) rxIntent.form = rxForm;
      render();
      return;
    }
  });

  /* Six digits and the element is signed, which is how every other PIN field in
     OpenEyes behaves. The PIN does not produce a prescription, it produces a
     signature on the element; the save produces the prescription. */
  document.addEventListener('input', function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains('proto-rx-pin')) return;
    if (ev.target.value.length >= 6 && rxForm) {
      ev.target.value = '';
      setRxIntent('sign');
      render();
      alertBox('', '<strong>Element signed</strong> by ' + esc(user().name)
        + '. Save the examination to generate the prescription.');
    }
  });

  /* The differences between the order being edited and the record, keyed by
     entry so a row can mark itself. Computed once per render. */
  function computeRxDiffMap() {
    rxDiffMap = {};
    var a = rxEditing();
    if (!a) return;
    var base = draftBaseline(a);
    if (!base) return;
    draftDiffs(a).forEach(function (d) {
      if (d.kind === 'changed' || d.kind === 'kept') {
        rxDiffMap[d.item.entryId] = { kind: d.kind, item: d.item, baseKind: base.kind };
      }
    });
  }

  /* The Prescriptions tab is either one prescription event, opened the way it
     would be on the timeline, or the reviewer's list across all of them. */
  function renderArtefacts() {
    var list = $('#proto-artefact-list');
    var one = $('#proto-rx-event');
    if (STATE.rxOpen && !rxById(STATE.rxOpen)) { STATE.rxOpen = null; STATE.rxMode = 'view'; }
    var a = STATE.rxOpen ? rxById(STATE.rxOpen) : null;
    if (a && STATE.rxMode === 'edit' && !isOpen(a)) STATE.rxMode = 'view';

    renderRxPicker(a);
    if (a) {
      list.hidden = true;
      list.innerHTML = '';
      one.hidden = false;
      one.innerHTML = artefactHtml(a, STATE.rxMode === 'edit');
    } else {
      one.hidden = true;
      one.innerHTML = '';
      list.hidden = false;
      list.innerHTML = STATE.artefacts.length
        ? STATE.artefacts.slice().reverse().map(function (x) { return artefactHtml(x, false); }).join('')
        : '<div class="proto-empty">No prescriptions issued.</div>';
    }
    placeElement(a);
    renderRxCommitBar();
  }

  function renderRxPicker(open) {
    var sel = $('#proto-rx-pick');
    var opts = ['<option value="">All orders, as a reviewer sees them</option>'];
    STATE.artefacts.slice().reverse().forEach(function (a) {
      opts.push('<option value="' + a.id + '"' + (open && open.id === a.id ? ' selected' : '') + '>'
        + esc(a.id + '  \u00b7  ' + (ARTEFACT_STATES[a.status] || {}).label + '  \u00b7  '
              + ((FORM_TYPES[a.formType] || {}).label || '') + '  \u00b7  ' + fmtDate(a.date)) + '</option>');
    });
    sel.innerHTML = opts.join('');
    sel.disabled = !STATE.artefacts.length;

    var btns = $('#proto-rx-modebtns');
    if (!open) {
      btns.innerHTML = '<span class="proto-drug-sub">Pick one to open it as its own prescription event.</span>';
      return;
    }
    var u = user();
    if (!isOpen(open)) {
      btns.innerHTML = '<span class="proto-drug-sub">Issued and cancelled orders are read-only. '
        + 'Cancel and reissue is the way to change one.</span>';
      return;
    }
    btns.innerHTML =
      '<button type="button" class="proto-rx-modebtn' + (STATE.rxMode === 'view' ? ' is-on' : '')
        + '" data-act="rx-mode" data-mode="view" data-rx="' + open.id + '">View mode</button>'
      + '<button type="button" class="proto-rx-modebtn' + (STATE.rxMode === 'edit' ? ' is-on' : '')
        + '" data-act="rx-mode" data-mode="edit" data-rx="' + open.id + '">Edit mode</button>'
      + (STATE.rxMode === 'edit'
          ? '<label class="proto-rx-onlybox"><input type="checkbox" data-act="rx-only"'
            + (STATE.rxOnly ? ' checked' : '') + '> Only this order\u2019s drugs</label>'
          : '<span class="proto-drug-sub">'
            + (u.canPrescribe
                ? 'Edit mode opens the Medications element inside this event.'
                : 'Edit mode lets you amend the request. Signing needs a prescriber.')
            + '</span>');
  }

  /* One element, moved to wherever the work is. Re-parenting the node rather than
     drawing a second one is the point: there is one medication record, and the
     prescription event is a place you edit it from, not a copy of it. */
  function placeElement(open) {
    var el = $('#proto-meds-element');
    var editing = rxEditing();
    var target = (editing && STATE.view === 'artefacts')
      ? $('#proto-rx-element-slot') : $('#proto-record-element-slot');
    if (el.parentNode !== target) target.appendChild(el);
    el.classList.toggle('is-rx-edit', !!editing);
    var title = el.querySelector('.element-title');
    title.innerHTML = editing
      ? 'Medications <span class="proto-drug-sub proto-el-sub">the record, edited from inside '
        + esc(editing.id) + '. Changes here are changes to the record, and they are what '
        + esc(editing.id) + ' will say.</span>'
      : 'Medications';
  }

  function artefactHtml(a, editing) {
    editing = !!editing;
    var single = STATE.rxOpen === a.id;
    var items = artefactItems(a);
    var diverged = divergedItems(a);
    var frozen = !!a.frozen;

    var ft = FORM_TYPES[a.formType] || FORM_TYPES.hospital;

    var base = draftBaseline(a);
    var diffs = draftDiffs(a);
    var diffBy = {};
    diffs.forEach(function (d) { diffBy[d.item.entryId] = d; });

    var meta = [];
    meta.push('Form: ' + esc(ft.label));
    meta.push(a.prescriber ? 'Prescriber: ' + esc(a.prescriber) : 'Prescriber: none yet, this is a request');
    if (a.requestedBy) meta.push('Requested ' + fmtWhen(a.requestedAt) + ' by ' + esc(a.requestedBy)
      + (a.requests.length > 1 ? ', amended ' + (a.requests.length - 1) + ' time' + (a.requests.length === 2 ? '' : 's') : ''));
    meta.push(a.signedAt ? 'Signed ' + fmtWhen(a.signedAt) + ' by ' + esc(a.signedBy) : 'Not yet signed');
    if (a.issuedAt) {
      meta.push('Issued ' + fmtWhen(a.issuedAt) + ' by ' + esc(a.issuedBy)
        + ' (' + (a.issueTrigger === 'print' ? 'printed' : 'pharmacy began signing') + ')');
    }
    if (a.printedAt) {
      meta.push('Printed ' + fmtWhen(a.printedAt)
        + (a.printCount > 1 ? ' (' + a.printCount + ' prints)' : ''));
    }
    if (a.supersedesId) meta.push('Replaces ' + esc(a.supersedesId));
    if (a.supersededById) meta.push('Replaced by ' + esc(a.supersededById));
    if (a.cancelledAt) meta.push('Cancelled ' + fmtWhen(a.cancelledAt) + ': ' + esc(a.cancelReason));

    /* In edit mode the two versions go side by side rather than one under the
       other. The reader's question is which of two directions this order will
       carry, and a column each is the shortest way to ask it. */
    var rows = (editing && base) ? editRows(a, items, base, diffBy) : items.map(function (i) {
      var s = i.snapshot;
      var dirs = [s.dose + (s.unit === 'drop' ? ' drop' + (s.dose === '1' ? '' : 's') : s.unit), s.freq, s.route];
      if (s.lat) dirs.push(s.lat);
      var d = diffBy[i.entryId];
      var drifted = d && (d.kind === 'changed' || d.kind === 'kept');
      var changed = diverged.indexOf(i) >= 0 || drifted;
      /* Two comparisons, one table. A signed order shows the snapshot and says
         what the record now says. A draft shows the record and says what was
         asked for, because that is the direction the reader needs. */
      var against = '';
      if (diverged.indexOf(i) >= 0) {
        against = 'record now says: ' + directions(findById(i.entryId));
      } else if (drifted) {
        against = (base.kind === 'requested' ? 'requested as: ' : 'signed as: ')
          + snapDirections(d.item.snapshot)
          + (d.kind === 'kept' ? ', kept as the record has it' : '');
      }
      return '<tr' + (changed ? ' class="proto-diverged-row"' : '') + '>'
        + '<td>' + esc(i.drug) + '<span class="proto-drug-sub">' + esc(i.sub) + '</span></td>'
        + '<td>' + esc(dirs.join(', '))
        +   (s.taper && s.taper.length ? '<span class="proto-drug-sub">then ' + s.taper.map(function (t) { return esc(t.freq) + ' from ' + fmtDate(t.from); }).join(', ') + '</span>' : '')
        +   (against ? '<span class="proto-drug-sub">' + esc(against) + '</span>' : '')
        + '</td>'
        + '<td>' + (ft.needsLocation && isOpen(a)
            ? '<select data-act="rx-loc" data-rx="' + a.id + '" data-item="' + i.entryId + '">'
              + locationsFor(a.condition).map(function (l) {
                  return '<option' + (i.location === l ? ' selected' : '') + '>' + esc(l) + '</option>';
                }).join('') + '</select>'
            : esc(i.location || (ft.needsLocation ? '' : 'Not applicable')))
        + '</td></tr>';
    }).join('');

    /* The dispensing instruction and the location are set on the order and only
       while it is still open. They are not on the medication row: they describe
       this act of supply, not the patient's standing treatment, which is why
       they had to come off the row when the record went patient-level. Once the
       order is issued they are frozen with everything else. */
    var conds = (ft.conditions || []).filter(function (c) { return inst().conditions.indexOf(c) >= 0; });
    if (!conds.length) conds = ft.conditions || [];
    var condCtl = !isOpen(a)
      ? esc(COND_LABELS[a.condition] || a.condition || '')
      : '<select data-act="rx-cond" data-rx="' + a.id + '">'
        + conds.map(function (c) {
            return '<option value="' + c + '"' + (c === a.condition ? ' selected' : '') + '>' + esc(COND_LABELS[c]) + '</option>';
          }).join('') + '</select>';
    if (condCtl) meta.push('Dispensing instruction: ' + condCtl);

    /* Pharmacy signatory chips, mirroring the four configurable roles the real
       worklist renders. Whether they apply at all is a property of the form,
       stated once, rather than inferred from the condition names on the items. */
    var chips = ft.pharmacy
      ? PHARMACY_ROLES.map(function (r) {
          var sig = a.pharmacy[r];
          return '<span class="proto-sig ' + (sig ? 'signed' : 'unsigned') + '"'
            + (sig ? ' title="' + esc(sig.by) + ', ' + fmtWhen(sig.at) + '"' : '')
            + '>' + esc(r) + '</span>';
        }).join(' ')
      : '<span class="proto-drug-sub">' + esc(ft.label)
        + ' does not go through hospital pharmacy, so no dispensing signatures apply.</span>';

    var actions = [];
    var u = user();
    if (!single) {
      actions.push(btn('rx-open', a.id, 'Open this prescription event', isDraft(a)));
    }
    /* Signing, reconciling and amending all happen in edit mode, because they
       are all decisions about what this order should say, and that is a question
       you cannot answer without the record in front of you. */
    if (single && !editing && isOpen(a)) {
      actions.push(btn('rx-open-edit', a.id,
        isDraft(a)
          ? (u.canPrescribe ? 'Open in edit mode to reconcile and sign' : 'Open in edit mode to amend the request')
          : 'Edit and sign again', true));
    }
    if (u.canPrescribe && a.status === 'signed' && !editing) {
      actions.push(btn('rx-print', a.id, printLabel(a, false), true));
    }
    if (u.canPrescribe && isIssued(a) && !editing) {
      actions.push(btn('rx-print', a.id, printLabel(a, true)));
      actions.push(btn('rx-cancel', a.id, 'Cancel'));
      actions.push(btn('rx-reissue', a.id, 'Cancel and reissue'));
    }
    if (u.canPrescribe && a.status === 'cancelled' && !a.supersededById) {
      actions.push(btn('rx-reissue', a.id, 'Reissue from current record'));
    }
    if (u.canPrescribe && a.query && !a.query.resolvedAt) {
      actions.push(btn('rx-resolve', a.id, 'Resolve query', true));
    }
    if (editing) actions = [];
    if (u.canDispense && ft.pharmacy && isIssued(a) && a.status !== 'complete') {
      outstandingRoles(a).slice(0, 1).forEach(function (r) {
        actions.push('<button type="button" class="button green" data-act="rx-role" data-rx="' + a.id + '" data-role="' + esc(r) + '">Sign as "' + esc(r) + '"</button>');
      });
      if (!a.query) actions.push(btn('rx-query', a.id, 'Raise query'));
    }

    /* Order-level note. Editable while the order is open, captured at issue.
       Per-drug comments already exist in the current system and are a separate field. */
    var noteBlock = '';
    if (isOpen(a) && u.canPrescribe) {
      noteBlock = '<div class="proto-notes"><label class="proto-field">Note to pharmacy (printed on the prescription)'
        + '<textarea rows="2" data-act="rx-note" data-rx="' + a.id + '" '
        + 'placeholder="e.g. Reissued, patient lost the original. Owed items to follow.">' + esc(a.notes) + '</textarea></label></div>';
    } else if (a.notes) {
      noteBlock = '<div class="proto-notes proto-notes-frozen"><span class="proto-worklist-label">Note</span> ' + esc(a.notes) + '</div>';
    }

    var notes = noteBlock;
    if (a.query) {
      notes += '<div class="proto-frozen-note proto-query">'
        + '<strong>Pharmacy query</strong> raised by ' + esc(a.query.by) + ', ' + fmtWhen(a.query.at) + ': &ldquo;' + esc(a.query.text) + '&rdquo;'
        + (a.query.resolvedAt
            ? '<br>Resolved ' + fmtWhen(a.query.resolvedAt) + ' by ' + esc(a.query.resolvedBy) + '.'
            : '<br>Completion is blocked until this is resolved.')
        + '</div>';
    }
    if (!frozen) {
      notes += draftNote(a, base, diffs, editing);
    } else if (diverged.length) {
      notes += '<div class="proto-frozen-note proto-diverged">'
        + '<strong>The medication record has changed since this was signed</strong>'
        + (a.divergedAt ? ', ' + fmtWhen(a.divergedAt) + ' by ' + esc(a.divergedBy) : '') + '.<br>'
        + diverged.map(function (i) {
            var e = findById(i.entryId);
            var s = i.snapshot;
            return esc(i.drug) + ': signed as <strong>' + esc(snapDirections(s))
              + '</strong>, record now says <strong>' + esc(directions(e)) + '</strong>';
          }).join('<br>')
        + '<br>' + (a.status === 'cancelled'
            ? 'This order was cancelled, so the difference is history rather than something to act on.'
            : isIssued(a)
              ? 'This order has been issued, so it cannot be changed. Cancel and reissue if the patient needs supply at the current directions.'
              : 'This order still says what was signed. Edit it and sign again to make it match, which keeps this order and its number, or cancel it, or leave it if the signed directions are still what should be dispensed.')
        + '</div>';
    } else if (a.status !== 'cancelled') {
      notes += '<div class="proto-frozen-note">Frozen at signature, and currently matches the medication record.</div>';
    }

    return '<section class="element proto-artefact' + (a.status === 'cancelled' ? ' is-cancelled' : '') + '">'
      + '<header class="element-header">'
      +   '<h3 class="element-title">' + esc(a.id)
      +     '<span class="proto-status ' + a.status + '">' + esc(ARTEFACT_STATES[a.status].label) + '</span>'
      +     (diverged.length
              ? '<span class="highlighter orange proto-diverged-flag" title="The medication record has changed since this order was signed">'
                + '<i class="oe-i warning-orange small pad-right"></i>Record changed</span>'
              : '')
      +   '</h3>'
      + '</header>'
      + '<div class="element-data full-width"><div class="data-group">'
      +   '<div class="proto-artefact-meta">' + meta.join('<br>') + '</div>'
      +   '<div class="proto-state-note">' + esc(ARTEFACT_STATES[a.status].note) + '</div>'
      +   '<table class="standard proto-sign-table' + (editing && base ? ' proto-rx-edit-table' : '') + '">'
      +     '<thead><tr><th>Drug</th>'
      +     (editing && base
              ? '<th>' + (base.kind === 'requested' ? 'As requested' : 'As previously signed')
                + '</th><th>As the record now stands, and what will be signed</th>'
                + (ft.needsLocation ? '<th>Dispense location</th>' : '') + '<th>Reconcile</th>'
              : '<th>' + (frozen ? 'Directions as signed' : 'Directions as the record now stands')
                + '</th><th>Dispense location</th>')
      +     '</tr></thead>'
      +     '<tbody>' + rows + '</tbody></table>'
      +   '<div class="proto-worklist-line"><span class="proto-worklist-label">Pharmacy worklist</span> ' + chips
      +     '<span class="proto-worklist-state">' + worklistState(a) + '</span></div>'
      +   notes
      +   (editing ? rxEventSignBar(a) : '')
      +   (actions.length ? '<div class="flex-layout flex-right" style="margin-top:10px">' + actions.join(' ') + '</div>' : '')
      + '</div></div></section>';
  }

  /* Which button the print action is, named after the paper it produces. Two
     templates, not two sizes of one: the hospital form carries the site's
     configured header and footer and stays on the pharmacy worklist, the FP10
     goes on statutory stationery and never reached the worklist at all. */
  function printLabel(a, again) {
    var ft = FORM_TYPES[a.formType] || FORM_TYPES.hospital;
    var what = a.formType === 'fp10' ? 'FP10' : (a.formType === 'pgd' ? 'supply record' : 'hospital prescription');
    return (again ? 'Reprint the ' : 'Print and issue: ') + what;
  }

  /* The reconciliation table. One row per drug on the order, the two versions
     beside each other, and the decision offered on the row rather than for the
     order as a whole: a four-drug order with one changed dose is not an
     all-or-nothing question. */
  function editRows(a, items, base, diffBy) {
    var u = user();
    var ft = FORM_TYPES[a.formType] || FORM_TYPES.hospital;
    var byId = {};
    items.forEach(function (i) { byId[i.entryId] = i; });
    var out = [];

    /* Routing, not direction, so it stays a live control while the order is
       open and changing it does not take the signature off. */
    function locCell(entryId) {
      if (!ft.needsLocation) return '';
      var i = byId[entryId];
      if (!i) return '<td></td>';
      return '<td><select data-act="rx-loc" data-rx="' + a.id + '" data-item="' + entryId + '">'
        + locationsFor(a.condition).map(function (l) {
            return '<option' + (i.location === l ? ' selected' : '') + '>' + esc(l) + '</option>';
          }).join('') + '</select></td>';
    }

    base.items.forEach(function (bi) {
      var d = diffBy[bi.entryId];
      var kind = d ? d.kind : 'same';
      var e = findById(bi.entryId);
      var onOrder = a.entryIds.indexOf(bi.entryId) >= 0;
      var now, act = '', cls = '';

      if (!onOrder) {
        now = '<span class="proto-rx-off">Taken off this order</span>';
        cls = ' class="proto-rx-offrow"';
        act = u.canPrescribe
          ? '<button type="button" class="proto-btn-confirm" data-act="rxitem-on" data-rx="' + a.id + '" data-item="' + bi.entryId + '">Put it back on</button>'
          : '';
      } else if (kind === 'gone' || kind === 'stopped') {
        now = '<span class="proto-rx-off">'
          + (e && e.stopReason ? 'Stopped since: ' + esc(e.stopReason) : 'No longer on the record')
          + '</span>';
        cls = ' class="proto-diverged-row"';
        act = (e && u.canPrescribe)
          ? '<button type="button" class="proto-btn-confirm" data-act="rx-restart" data-rx="' + a.id + '" data-item="' + bi.entryId + '">Restart it</button>'
          : '';
      } else if (kind === 'changed' || kind === 'kept') {
        now = '<strong>' + esc(directions(e)) + '</strong>'
          + (kind === 'kept' ? '<span class="proto-drug-sub">Kept as the record has it</span>' : '');
        cls = ' class="proto-diverged-row"';
        act = u.canPrescribe
          ? (kind === 'kept' ? '<span class="proto-drug-sub">Decided</span>' : '')
            + '<button type="button" class="proto-btn-confirm" data-act="rx-keep" data-rx="' + a.id + '" data-item="' + bi.entryId + '">Keep this</button> '
            + '<button type="button" class="proto-btn-confirm" data-act="rx-restore" data-rx="' + a.id + '" data-item="' + bi.entryId + '">Restore</button>'
          : '<span class="proto-drug-sub">A prescriber decides</span>';
      } else {
        now = esc(directions(e));
        act = '<span class="proto-rx-same">Unchanged</span>';
      }

      out.push('<tr' + cls + '>'
        + '<td>' + esc(bi.drug) + '<span class="proto-drug-sub">' + esc(bi.sub) + '</span></td>'
        + '<td>' + esc(snapDirections(bi.snapshot)) + '</td>'
        + '<td>' + now + '</td>'
        + (ft.needsLocation ? (onOrder ? locCell(bi.entryId) : '<td></td>') : '')
        + '<td>' + act + '</td></tr>');
    });

    /* Drugs added to the order in this sitting were on no earlier version of it,
       so they have nothing to compare against and are marked as new. */
    items.forEach(function (i) {
      if (base.items.some(function (bi) { return bi.entryId === i.entryId; })) return;
      out.push('<tr class="proto-rx-newrow">'
        + '<td>' + esc(i.drug) + '<span class="proto-drug-sub">' + esc(i.sub) + '</span></td>'
        + '<td><span class="proto-rx-off">Not on the earlier version</span></td>'
        + '<td><strong>' + esc(directions(findById(i.entryId))) + '</strong></td>'
        + locCell(i.entryId)
        + '<td><span class="proto-rx-same">Added here</span></td></tr>');
    });

    return out.join('');
  }

  /* The signing control for an order being edited inside its own event. Same
     rule as the element: the PIN signs, the save is what makes it an order. */
  function rxEventSignBar(a) {
    var u = user();
    var items = artefactItems(a);
    var signable = items.length > 0 && items.every(function (i) {
      var e = findById(i.entryId);
      return e && canSignForm(a.formType, e);
    });
    var open = draftDiffs(a).filter(function (d) { return d.kind === 'changed'; }).length;

    var inner;
    if (rxeIntent && rxeIntent.mode === 'sign') {
      inner = '<span class="proto-rx-signed">' + SIGNATURE_SVG
        + '<span><strong>' + esc(rxeIntent.by) + '</strong>, ' + esc(rxeIntent.at) + '</span>'
        + '<button type="button" class="proto-sig-clear" data-act="rxe-clear">Remove</button></span>'
        + '<div class="proto-rx-note">' + esc(a.id) + ' is not signed yet. The signature and any change you '
        + 'made to the record are written by the same save, so this becomes a signed order when you save this '
        + 'prescription, and not before.</div>';
    } else if (rxeIntent && rxeIntent.mode === 'request') {
      inner = '<button type="button" class="proto-rx-opt is-on" data-act="rxe-opt" aria-pressed="true">Amend the request</button>'
        + '<div class="proto-rx-note">The request will be updated to say what the record says when you save. '
        + 'It stays unsigned, so nobody may act on it yet.</div>';
    } else if (signable) {
      inner = '<span class="proto-pin-wrap">'
        + '<i class="oe-i padlock small no-click"></i>'
        + '<input type="password" class="proto-rxe-pin" maxlength="6" inputmode="numeric" placeholder="****" autocomplete="off">'
        + '<span class="proto-pin-label">Sign by PIN</span></span>'
        + '<div class="proto-rx-note">'
        + (open ? '<strong>' + open + ' drug' + (open === 1 ? ' differs' : 's differ') + ' from what was '
                  + (draftBaseline(a).kind === 'requested' ? 'requested' : 'signed before')
                  + '.</strong> Decide each one above, or sign as the record stands, which is what the '
                  + 'signature will cover. '
                : 'Nothing has moved since, so this signs what you can see. ')
        + 'The PIN signs the element. The order is signed when you save this prescription.</div>';
    } else {
      inner = '<button type="button" class="proto-rx-opt" data-act="rxe-opt" aria-pressed="false">Amend the request</button>'
        + '<div class="proto-rx-note">You cannot sign '
        + esc(formPhraseA(a.formType)) + ', so there is no PIN here. You can change the record and amend '
        + 'the request, and a prescriber signs it.</div>';
    }

    return '<div class="proto-rx-bar proto-rx-eventsign">'
      + '<div class="proto-rx-bar-sel"><span class="proto-rx-count">' + esc(a.id) + '</span> '
      + '<span class="proto-rx-names">' + esc((FORM_TYPES[a.formType] || {}).label || '') + ', '
      + items.length + ' drug' + (items.length === 1 ? '' : 's') + '</span></div>'
      + inner + '</div>';
  }

  /* A signature on an order covers a stated set of directions. Change any of
     them, or which drugs are on the order, and it has to come off. */
  function rxeFingerprint(a) {
    return JSON.stringify([
      STATE.user, a.id, a.formType, a.condition,
      a.entryIds.slice().sort(),
      artefactItems(a).map(function (i) { return i.entryId + '|' + snapDirections(i.snapshot) + '|' + i.location; })
    ]);
  }
  function checkRxeIntent() {
    var a = rxEditing();
    if (!a) { rxeIntent = null; return; }
    if (!rxeIntent) return;
    if (rxeIntent.rx !== a.id) { rxeIntent = null; return; }
    if (rxeIntent.mode !== 'sign') return;
    if (rxeIntent.fp === rxeFingerprint(a)) return;
    rxeIntent = null;
    alertBox('patient', '<strong>The signature on ' + esc(a.id) + ' has come off.</strong> '
      + 'Something it covered changed, so it no longer attests to what is in front of you. '
      + 'Nothing was generated. Sign again when the order says what you mean.');
  }

  function renderRxCommitBar() {
    var bar = $('#proto-rx-commit-bar');
    var a = rxEditing();
    var pend = pendingChanges();
    bar.hidden = !a || (!pend.length && !rxeIntent);
    if (bar.hidden) return;
    var text = '';
    if (pend.length) {
      text = '<strong>' + pend.length + ' change' + (pend.length === 1 ? '' : 's')
        + ' to the medication record, not yet saved.</strong> ';
    }
    if (rxeIntent && rxeIntent.mode === 'sign') {
      text += '<strong>' + esc(a.id) + ' is signed on this screen and not yet in the record</strong>, by '
        + esc(rxeIntent.by) + '. Saving writes the record change and the signed order together.';
    } else if (rxeIntent) {
      text += '<strong>The request on ' + esc(a.id) + ' will be amended when you save.</strong>';
    } else {
      text += 'Saving writes them and leaves ' + esc(a.id) + ' unsigned.';
    }
    $('#proto-rx-commit-text').innerHTML = text;
  }

  /* The draft's own block. It answers three questions in order: what was asked
     for and by whom, what has moved since, and what will be snapshotted if a PIN
     is typed now. The reconciliation is offered row by row rather than for the
     order as a whole, because a four-drug request with one changed dose should
     not be an all-or-nothing decision. */
  function draftNote(a, base, diffs, editing) {
    var u = user();
    if (!base) {
      return '<div class="proto-frozen-note proto-projection">Unsigned draft, and nothing has been '
        + 'requested or signed on it yet.</div>';
    }
    var changed = diffs.filter(function (d) { return d.kind === 'changed'; });
    var kept = diffs.filter(function (d) { return d.kind === 'kept'; });
    var absent = diffs.filter(function (d) { return d.kind === 'stopped' || d.kind === 'gone'; });
    var head = base.kind === 'requested'
      ? '<strong>Requested by ' + esc(base.by) + ', ' + fmtWhen(base.at) + '.</strong> '
        + 'Nobody has signed it, so it is an instruction to nobody yet.'
      : '<strong>Signed by ' + esc(base.by) + ', ' + fmtWhen(base.at) + ', and that signature has come off.</strong> '
        + 'The order keeps its number and its history.';

    var lines = changed.concat(kept).map(function (d) {
      return '<li><span class="proto-strong">' + esc(d.item.drug) + '</span> &mdash; '
        + (base.kind === 'requested' ? 'requested as ' : 'signed as ')
        + '<strong>' + esc(snapDirections(d.item.snapshot)) + '</strong>, '
        + 'record now says <strong>' + esc(directions(d.entry)) + '</strong>. '
        + (d.kind === 'kept'
            ? 'Kept as the record has it.'
            : (u.canPrescribe
                ? '<button type="button" class="proto-btn-confirm" data-act="rx-keep" data-rx="' + a.id + '" data-item="' + d.item.entryId + '">Keep what the record says</button> '
                  + '<button type="button" class="proto-btn-confirm" data-act="rx-restore" data-rx="' + a.id + '" data-item="' + d.item.entryId + '">Restore what was requested</button>'
                : 'A prescriber decides which of the two to sign.'))
        + '</li>';
    }).concat(absent.map(function (d) {
      return '<li><span class="proto-strong">' + esc(d.item.drug) + '</span> &mdash; '
        + (base.kind === 'requested' ? 'requested, ' : 'signed for, ')
        + (d.entry && d.entry.stopReason ? 'stopped since: ' + esc(d.entry.stopReason) : 'no longer on the record')
        + '. Left off the order, because prescribing a drug somebody has just stopped needs a positive decision. '
        + (d.entry && u.canPrescribe
            ? '<button type="button" class="proto-btn-confirm" data-act="rx-restart" data-rx="' + a.id + '" data-item="' + d.item.entryId + '">Restart it</button>'
            : '')
        + '</li>';
    })).join('');

    var tail = (changed.length || absent.length)
      ? 'Signing snapshots the directions in the table above, which is the record as it now stands, not what was '
        + (base.kind === 'requested' ? 'requested' : 'signed before') + '.'
      : 'Nothing has changed on the record since, so this is ready to sign as it stands.';

    return '<div class="proto-frozen-note ' + (changed.length || absent.length ? 'proto-diverged' : 'proto-projection') + '">'
      + head + '<br>' + tail
      /* In edit mode the table above already asks this drug by drug, so the
         block states the provenance and gets out of the way. */
      + (lines && !editing ? '<ul class="proto-reconcile-list">' + lines + '</ul>' : '')
      + '</div>';
  }

  function btn(act, id, label, primary) {
    return '<button type="button" class="button' + (primary ? ' green' : '') + '" data-act="' + act + '" data-rx="' + id + '">' + esc(label) + '</button>';
  }

  /* What the pharmacy worklist would show. In the current system this is derived
     by counting signature rows; here it is a property of the artefact. */
  function worklistState(a) {
    var ft = FORM_TYPES[a.formType] || FORM_TYPES.hospital;
    if (a.status === 'cancelled') return 'Shown as cancelled';
    if (!ft.pharmacy) return 'Never on the hospital pharmacy worklist';
    /* Signed, not just issued. The first dispensing signature is one of the things
       that issues an order, so an issued-only worklist would mean pharmacy could
       never start. Today print is not part of the filter either, so unprinted
       hospital orders reach pharmacy and must go on doing so. Drafts do not. */
    if (isDraft(a)) return 'Not on the worklist while unsigned';
    if (a.status === 'complete') return 'Complete, off the worklist';
    var left = outstandingRoles(a).length;
    return 'Outstanding, ' + left + ' of ' + PHARMACY_ROLES.length + ' role' + (left === 1 ? '' : 's') + ' to sign'
      + (divergedItems(a).length ? '. Flagged: record changed since signature' : '');
  }

  /* --------------------------------------------------------------- actions */

  function alertBox(kind, html) {
    var wrap = $('#proto-alerts');
    var div = document.createElement('div');
    div.className = 'alert-box ' + kind;
    div.innerHTML = html;
    wrap.appendChild(div);
    setTimeout(function () { div.remove(); }, 9000);
  }

  function openPopup(id) { $('#' + id).hidden = false; }
  function closePopups() { $$('.oe-popup-wrap').forEach(function (p) { p.hidden = true; }); }

  var editingId = null, stoppingId = null, taperDraft = [];

  document.addEventListener('click', function (ev) {
    /* The set adder is handled before the shared lookup, because its rows are
       plain li elements and would otherwise fall through it. */
    var setRow = ev.target.closest('#proto-set-list li[data-id]');
    if (setRow) {
      ev.preventDefault();
      $$('#proto-set-list li.selected').forEach(function (li) { li.classList.remove('selected'); });
      setRow.classList.add('selected');
      return;
    }
    if (ev.target.closest('#proto-set-confirm')) {
      ev.preventDefault();
      var picked = $('#proto-set-list li.selected');
      closeSetPicker();
      if (picked) addSet(picked.dataset.id);
      return;
    }
    /* Changing the side changes which drugs are duplicates, so the whole plan is
       worked out again rather than the side being remembered and applied later. */
    var sideBtn = ev.target.closest('#proto-setplan-side label');
    if (sideBtn) {
      var input = sideBtn.querySelector('input');
      if (input) { openSetPlan(pendingSetPlan.src, input.value); }
      return;
    }
    if (ev.target.closest('#proto-setplan-go')) {
      ev.preventDefault();
      var choices = {};
      $$('#proto-setplan-body input[type=radio]:checked').forEach(function (r) { choices[r.name] = r.value; });
      applySetPlan(pendingSetPlan.src, pendingSetPlan.plan, choices, pendingSetPlan.side);
      return;
    }
    /* Close on the adder's own close icon, or on any click outside it. */
    if (ev.target.closest('#adder-set .close-icon-btn')) { ev.preventDefault(); closeSetPicker(); return; }
    if (!ev.target.closest('#adder-set')) closeSetPicker();

    var t = ev.target.closest('[data-act], [data-rx-opt], .proto-tab, .proto-add, .proto-set-add, .proto-close, .proto-result, .proto-pin-label');
    if (!t) return;

    if (t.classList.contains('proto-set-add')) {
      ev.preventDefault();
      openSetPicker(t.id === 'proto-btn-pgd' ? 'pgd' : 'standard', t);
      return;
    }

    if (t.classList.contains('proto-close')) { ev.preventDefault(); closePopups(); return; }

    if (t.classList.contains('proto-tab')) {
      ev.preventDefault();
      switchView(t.dataset.view);
      return;
    }

    if (t.classList.contains('proto-add') || t.closest('.proto-add')) { ev.preventDefault(); openAdd(); return; }

    /* Picking the draft box and taking a signature back off are both changes of
       mind about what the save should do, not actions in themselves. */
    if (t.dataset.rxOpt) {
      ev.preventDefault();
      if (t.dataset.rxOpt === 'clear') { rxIntent = null; }
      else if (rxIntent && rxIntent.mode === 'draft') { rxIntent = null; }
      else if (rxForm) { setRxIntent('draft'); }
      render();
      return;
    }

    var act = t.dataset.act;
    var e = t.dataset.id ? findById(t.dataset.id) : null;

    switch (act) {
      case 'edit':     openEdit(e); break;
      case 'stop':     openAction(e, 'stop'); break;
      case 'history':  openHistory(e); break;
      case 'thread':   historyId = t.dataset.id; renderHistory(); break;
      case 'op-hold':  resolveSurgeryHold(e, t.dataset.plan); break;
      case 'hold':     if (e.status === 'held') { toggleHold(e); } else { openAction(e, 'hold'); } break;
      case 'relevance': toggleRelevance(e); break;
      case 'confirm':  openConfirm(e, t.dataset.kind); break;
      case 'restart':  restart(e); break;
      case 'tab':          switchView(t.dataset.tab); break;
      case 'rx-keep':      rxKeep(t.dataset.rx, t.dataset.item); break;
      case 'rx-restore':   rxRestore(t.dataset.rx, t.dataset.item); break;
      case 'rx-restart':   rxRestart(t.dataset.rx, t.dataset.item); break;
      case 'rx-print':     rxPrint(t.dataset.rx); break;
      case 'rx-role':      rxSignRole(t.dataset.rx, t.dataset.role); break;
      case 'rx-open':      openRx(t.dataset.rx, 'view'); break;
      case 'rx-open-edit': openRxEdit(t.dataset.rx); break;
      case 'rx-mode':      t.dataset.mode === 'edit' ? openRxEdit(t.dataset.rx) : openRx(t.dataset.rx, 'view'); break;
      case 'rxitem-on':    rxSetItem(t.dataset.item, true); break;
      case 'rxe-clear':    rxeIntent = null; render(); alertBox('', 'Signature removed. Nothing was generated.'); break;
      case 'rxe-opt':      rxToggleRequestIntent(); break;
      case 'rx-cancel':    openCancel(t.dataset.rx, false); break;
      case 'rx-reissue':   openCancel(t.dataset.rx, true); break;
      case 'rx-query':     openQuery(t.dataset.rx); break;
      case 'rx-resolve':   rxResolve(t.dataset.rx); break;
      case 'supply-accept-gp': acceptGpContinues(t.dataset.rx); break;
      case 'supply-decline-gp': alertBox('', 'Left as it is. The order still says the GP continues; the record does not.'); break;
    }
  });

  document.addEventListener('change', function (ev) {
    if (ev.target.id === 'proto-role') {
      STATE.user = ev.target.value;
      render();
      alertBox('', 'Now acting as <strong>' + esc(user().name) + '</strong> (' + esc(user().role) + '). '
        + (user().canPrescribe ? 'Prescribing is available.' : 'Prescribing is not available for this role.'));
      return;
    }
    if (ev.target.dataset && ev.target.dataset.act === 'rx-cond') {
      var ac = rxById(ev.target.dataset.rx);
      ac.condition = ev.target.value;
      /* A condition change can change which locations are legal, so any location
         that no longer exists falls back rather than lingering as a stale value. */
      var legal = locationsFor(ac.condition);
      Object.keys(ac.locations).forEach(function (k) {
        if (legal.indexOf(ac.locations[k]) === -1) ac.locations[k] = legal[0];
      });
      render();
      maybeAdviseGpContinues(ac);
      return;
    }
    if (ev.target.dataset && ev.target.dataset.act === 'rx-loc') {
      rxById(ev.target.dataset.rx).locations[ev.target.dataset.item] = ev.target.value;
      return;
    }
    if (ev.target.dataset && ev.target.dataset.act === 'rx-note') {
      rxById(ev.target.dataset.rx).notes = ev.target.value;
      return;
    }
    if (ev.target.dataset && ev.target.dataset.act === 'rxsel') {
      var id = ev.target.dataset.id;
      var at = STATE.selected.indexOf(id);
      if (ev.target.checked && at === -1) STATE.selected.push(id);
      if (!ev.target.checked && at >= 0) STATE.selected.splice(at, 1);
      renderPrescribeBar();
      return;
    }
    if (ev.target.dataset && ev.target.dataset.act === 'supply') {
      setSupplyInline(findById(ev.target.dataset.id), ev.target.value);
      return;
    }
    if (ev.target.id === 'proto-add-from') {
      renderAddCommit();
      return;
    }
  });

  /* ---- views ---- */

  var GUIDE = {
    record: 'Try adding a drug the patient is already on, setting a duration and a reducing course from the Change dialog, or changing a dose that is already on an issued prescription. Watch the unsaved-changes bar: nothing is in the record, and no prescription exists, until the examination is saved. Switch role in the top right to see prescribing rights change.',
    artefacts: 'A prescription is editable until it is issued, and frozen from then on. Issue means printed, or pharmacy has started signing. Sign one and save the examination to generate it, change a dose on the record and watch the order report the difference; then print it and try the same change. Switch to the Pharmacist role to sign the dispensing roles or raise a query.',
    model: 'This tab is a reading aid, not part of the proposed interface.'
  };

  function switchView(v) {
    /* Leaving the Prescriptions tab leaves the prescription event. The element
       goes back where it lives, unsaved record changes stay pending because they
       belong to the record rather than to the order, and a signature that was
       waiting comes off, because it was a signature on a screen nobody is
       looking at any more. */
    var leaving = v !== 'artefacts' && rxEditing();
    var droppedSig = leaving && rxeIntent && rxeIntent.mode === 'sign';
    if (leaving) { STATE.rxMode = 'view'; rxeIntent = null; }
    $$('.proto-view').forEach(function (el) { el.hidden = el.id !== 'view-' + v; });
    $$('.proto-tab').forEach(function (el) { el.classList.toggle('selected', el.dataset.view === v); });
    $('#proto-guide-text').textContent = GUIDE[v];
    STATE.view = v;
    placeElement();
    renderPrescribeBar();
    renderRxCommitBar();
    if (droppedSig) {
      alertBox('patient', 'You left the prescription before saving it, so the signature came off. '
        + 'Nothing was signed. Any change you made to the medication record is still unsaved and still here.');
    }
  }

  /* ---- add ---- */

  /* The adder is one dialog with three ways into the same list: a short column
     of the drugs this specialty starts most often, a short column of the
     systemic drugs it cares about, and a search for everything else. No route
     question up front, because the route decides which group the drug lands in,
     and the route is set on the next screen. That is why there is one green plus
     rather than an "Add eye medication" button beside every group. */
  var COMMON_EYE = ['Latanoprost', 'Dorzolamide / Timolol', 'Dexamethasone', 'Chloramphenicol', 'Hypromellose', 'Timolol', 'Brimonidine'];
  var COMMON_SYSTEMIC = ['Acetazolamide', 'Prednisolone', 'Doxycycline', 'Hydroxychloroquine', 'Amlodipine', 'Metformin'];

  /* A list, not a single pick. Recording the six things a patient walked in on
     is one job, and making it six trips through the dialog is the reason nobody
     does it. Starting a drug is still one at a time, which the commit buttons
     enforce rather than the list. */
  var addPicks = [];

  function openAdd() {
    addPicks = [];
    $('#proto-search').value = '';
    $('#proto-add-brands').checked = false;
    $('#proto-add-pf').checked = false;
    renderAdderColumn('proto-add-common-eye', COMMON_EYE);
    renderAdderColumn('proto-add-common-sys', COMMON_SYSTEMIC);
    renderSearch('');
    renderAddNote();
    renderAddCommit();
    openPopup('popup-add');
    setTimeout(function () { $('#proto-search').focus(); }, 30);
  }

  function catalogueFor(names) {
    return names.map(function (n) { return CATALOGUE.filter(function (c) { return c.drug === n; })[0]; })
      .filter(Boolean);
  }

  /* A drug already on the record is dimmed rather than badged, because the
     answer is to change the existing row, not to add a second one. Tiers 2 and
     3 get a warning glyph: they are addable, and the reason is spelled out in
     the panel on the right once the drug is picked. */
  function adderOption(c) {
    var idx = CATALOGUE.indexOf(c);
    var cf = conflictsFor(c);
    var top = cf.length ? cf[0].tier : 0;
    /* A drug on the record in one eye may legitimately be wanted in the other, and
       the side is not chosen until the next screen. So dimming is only right where
       the route cannot take a side: you cannot be on a tablet twice, but you can be
       on a drop in each eye. The real check runs once the side is known. */
    var maybeOtherEye = top === 1 && routeTakesSide(c.route)
      && cf[0].entry.lat && cf[0].entry.lat !== 'Both';
    var block = top === 1 && !maybeOtherEye;
    var flag = '';
    if (c.allergy) flag = ' <i class="oe-i allergy small no-click" title="Allergy recorded"></i>';
    else if (maybeOtherEye) flag = ' <i class="oe-i warning small no-click" title="On the record for the '
      + esc(cf[0].entry.lat.toLowerCase()) + ' eye. Can be added for the other eye."></i>';
    else if (top === 2 || top === 3) flag = ' <i class="oe-i warning small no-click" title="' + esc(cf[0].detail) + '"></i>';
    var picked = addPicks.indexOf(idx) >= 0;
    var cls = [];
    if (block) cls.push('is-on-record');
    if (picked) cls.push('selected');
    return '<label' + (cls.length ? ' class="' + cls.join(' ') + '"' : '')
      + (block ? ' title="Already on the record"' : '') + '>'
      + '<input type="checkbox" name="proto-add-pick" value="' + idx + '"'
      + (picked ? ' checked' : '') + '>'
      + '<span class="li">' + esc(c.drug) + flag
      + '<span class="proto-opt-sub">' + esc(c.sub) + '</span></span></label>';
  }

  function renderAdderColumn(id, names) {
    $('#' + id).innerHTML = catalogueFor(names).map(adderOption).join('');
  }

  /* The two search options are IDG's. Brand names are off by default because a
     brand match is a different product record, and preservative free is the
     filter people actually ask for at the drop-by-drop level. */
  function renderSearch(q) {
    q = q.toLowerCase();
    var brands = $('#proto-add-brands').checked;
    var pf = $('#proto-add-pf').checked;
    var hits = CATALOGUE.filter(function (c) {
      if (pf && !c.pf) return false;
      var hay = (c.drug + (brands ? ' ' + c.sub : '')).toLowerCase();
      return !q || hay.indexOf(q) >= 0;
    });
    $('#proto-search-results').innerHTML = hits.length
      ? hits.map(adderOption).join('')
      : '<div class="proto-empty">No matches</div>';
  }

  /* The warnings the columns only hint at with an icon are spelled out here,
     so the reason a drug is flagged is readable before it is picked. */
  function renderAddNote() {
    var box = $('#proto-add-note');
    if (!addPicks.length) { box.innerHTML = ''; return; }
    var c = CATALOGUE[addPicks[addPicks.length - 1]];
    var bits = [];
    if (c.allergy) bits.push('<span class="highlighter warning">Allergy recorded</span>');
    conflictsFor(c).forEach(function (x) {
      bits.push('<div class="fade">' + esc(x.detail) + ': ' + esc(x.entry.drug) + '</div>');
    });
    box.innerHTML = '<div class="proto-add-picked"><strong>' + esc(c.drug) + '</strong><br>'
      + '<span class="fade">' + esc(c.sub) + '</span></div>' + bits.join('');
  }

  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'proto-search') renderSearch(ev.target.value);
  });

  document.addEventListener('change', function (ev) {
    if (ev.target.id === 'proto-add-brands' || ev.target.id === 'proto-add-pf') {
      renderSearch($('#proto-search').value);
      return;
    }
    if (ev.target.name === 'proto-add-pick') {
      var idx = parseInt(ev.target.value, 10);
      var at = addPicks.indexOf(idx);
      if (ev.target.checked) { if (at < 0) addPicks.push(idx); }
      else if (at >= 0) addPicks.splice(at, 1);
      /* The same drug appears in a common column and in the search results, so
         both copies have to reflect the selection. */
      refreshAdderLists();
      renderAddNote();
      renderAddCommit();
    }
  });

  function refreshAdderLists() {
    renderAdderColumn('proto-add-common-eye', COMMON_EYE);
    renderAdderColumn('proto-add-common-sys', COMMON_SYSTEMIC);
    renderSearch($('#proto-search').value);
  }

  /* The running list, and the two commit buttons. Recording history takes any
     number; starting treatment takes exactly one, because the next screen sets
     a dose, a side and a course for one specific drug and there is no sensible
     way to do that for six at once. */
  function addFrom() {
    var sel = $('#proto-add-from');
    return (sel && sel.value) || 'patient_reported';
  }
  function addFromPhrase() {
    var k = addFrom();
    if (k === 'gp_letter') return 'from a GP letter';
    if (k === 'shared_care_record') return 'from the shared care record';
    if (k === 'provider_letter') return "from another provider's letter";
    return 'reported by the patient';
  }

  function renderAddCommit() {
    var n = addPicks.length;
    var box = $('#proto-add-selected');
    box.innerHTML = n
      ? '<h4>Selected <span class="fade">(' + n + ')</span></h4>'
        + addPicks.map(function (i) {
            var c = CATALOGUE[i];
            return '<div class="proto-sel-row" data-unpick="' + i + '">'
              + '<i class="oe-i remove-circle small"></i> ' + esc(c.drug)
              + '<span class="fade"> ' + esc(c.sub) + '</span></div>';
          }).join('')
      : '';

    var existing = $('#proto-add-existing');
    var fresh = $('#proto-add-new');
    var fromWrap = $('#proto-add-from-wrap');
    existing.disabled = n === 0;
    var fromLabel = {
      patient_reported: 'reported by the patient',
      gp_letter: 'from a GP letter',
      shared_care_record: 'from the shared care record',
      provider_letter: "from another provider's letter"
    }[addFrom()] || 'reported by the patient';
    existing.textContent = n > 1
      ? 'Record ' + n + ' existing medications ' + fromLabel
      : 'Record existing medication ' + fromLabel;
    fresh.disabled = n !== 1;
    if (fromWrap) fromWrap.hidden = n === 0;

    $('#proto-add-hint').textContent = n === 0
      ? 'Pick one drug to start, or several the patient is already taking.'
      : n === 1
        ? 'Recording an existing drug sets the source from the from: selector and leaves the GP responsible. Starting one opens the dose and course.'
        : n + ' selected. Only existing medications can be recorded in a batch: starting a drug needs a dose, a side and a course, so it is one at a time.';
  }

  document.addEventListener('click', function (ev) {
    var row = ev.target.closest && ev.target.closest('[data-unpick]');
    if (!row) return;
    var idx = parseInt(row.dataset.unpick, 10);
    var at = addPicks.indexOf(idx);
    if (at >= 0) addPicks.splice(at, 1);
    refreshAdderLists();
    renderAddNote();
    renderAddCommit();
  });

  $('#proto-add-new').addEventListener('click', function () {
    if (addPicks.length !== 1) return;
    pickDrug(addPicks[0], false);
  });

  $('#proto-add-existing').addEventListener('click', function () {
    if (!addPicks.length) return;
    if (addPicks.length === 1) { pickDrug(addPicks[0], true); return; }
    recordExistingBatch(addPicks.slice());
  });

  /* Tiers 1 to 3 from chapter 2. Tier 1 is exact product and is prevented by
     construction. Tiers 2 and 3 are advisory, because a second beta blocker is
     sometimes deliberate and the system does not get to decide.

     Substances are held per product, so a combination product overlaps with its
     own components: timolol conflicts with Cosopt, which is the case an
     exact-name match misses entirely. */
  function catFor(drug) { return CATALOGUE.filter(function (c) { return c.drug === drug; })[0] || {}; }
  function shared(a, b) {
    return (a || []).filter(function (x) { return (b || []).indexOf(x) >= 0; });
  }

  /* `side` is the side being proposed. Where it is known, a same-product match on
     the other eye is not a duplicate at all: the two eyes are separate threads and
     a patient can legitimately be on the same drop in each, on different regimens.
     Passing no side keeps the old behaviour, which is what the single-drug adder
     wants because it runs before a side has been chosen. */
  function conflictsFor(c, ignoreId, side) {
    var out = [];
    STATE.entries.forEach(function (e) {
      if (e.status === 'stopped' || e.id === ignoreId) return;
      var ec = catFor(e.drug);
      if (e.drug === c.drug) {
        if (side !== undefined && !sidesOverlap(side, e.lat)) return;
        out.push({ tier: 1, entry: e, detail: 'the same product' });
        return;
      }
      var subs = shared(c.vtm, ec.vtm);
      if (subs.length) {
        out.push({ tier: 2, entry: e, detail: 'both contain ' + subs.join(' and ') });
        return;
      }
      var cls = shared(c.cls, ec.cls);
      if (cls.length) {
        out.push({ tier: 3, entry: e, detail: 'both are a ' + cls.join(' and a ') });
      }
    });
    return out.sort(function (a, b) { return a.tier - b.tier; });
  }

  var TIER_WORDS = {
    1: 'Already on the record',
    2: 'Same drug in another product',
    3: 'Same class of drug'
  };

  function openConflict(c, conflicts, onProceed) {
    var top = conflicts[0].tier;
    closePopups();
    $('#proto-dup-title').textContent = TIER_WORDS[top];
    $('#proto-dup-drug').textContent = c.drug + ' ' + c.sub;
    $('#proto-dup-list').innerHTML = conflicts.map(function (x) {
      return '<div>Conflicts with <strong>' + esc(x.entry.drug) + '</strong> ' + esc(x.entry.sub)
        + ' &mdash; ' + esc(x.detail) + '</div>';
    }).join('');
    $('#proto-dup-edit').dataset.id = conflicts[0].entry.id;

    /* A tier-1 match against a drug that has not started yet is its own case,
       raised in the DA review: the user is almost always trying to bring the
       start forward, and being told "change the existing entry" does not say
       that. Two named outcomes instead of one generic instruction. */
    var planned = conflicts[0].tier === 1 && conflicts[0].entry.status === 'planned'
      ? conflicts[0].entry : null;

    if (planned) {
      $('#proto-dup-title').textContent = 'Already on the record, starting later';
      $('#proto-dup-explain').textContent = 'This drug is already recorded, set to start on '
        + fmtDate(planned.start) + '. Adding it again would leave the patient with two entries for the same drug. '
        + 'Either keep the planned start, or bring it forward to today, which replaces the planned entry '
        + 'rather than adding a second one.';
      $('#proto-dup-anyway').hidden = true;
      $('#proto-dup-bringforward').hidden = false;
      $('#proto-dup-bringforward').dataset.id = planned.id;
      $('#proto-dup-edit').textContent = 'Keep the planned start';
    } else if (top === 1) {
      $('#proto-dup-bringforward').hidden = true;
      $('#proto-dup-explain').textContent = 'The record holds at most one active entry per drug per patient. '
        + 'Rather than creating a second line, change the existing one. Its full history is preserved.';
      $('#proto-dup-anyway').hidden = true;
      $('#proto-dup-edit').textContent = 'Change the existing entry';
    } else if (top === 2) {
      $('#proto-dup-bringforward').hidden = true;
      $('#proto-dup-explain').textContent = 'This is not an exact duplicate, so it is not blocked, but the patient '
        + 'would be taking the same substance twice. That is occasionally deliberate and usually not. '
        + 'The system asks rather than decides.';
      $('#proto-dup-anyway').hidden = false;
      $('#proto-dup-edit').textContent = 'Change the existing entry instead';
    } else {
      $('#proto-dup-bringforward').hidden = true;
      $('#proto-dup-explain').textContent = 'Two drugs of the same class. Advisory only, because this is often '
        + 'intended. Class comes from a drug set, not from DM+D, so it is only as good as that set.';
      $('#proto-dup-anyway').hidden = false;
      $('#proto-dup-edit').textContent = 'Change the existing entry instead';
    }
    pendingProceed = onProceed;
    openPopup('popup-duplicate');
  }

  var pendingProceed = null;

  $('#proto-dup-anyway').addEventListener('click', function () {
    var go = pendingProceed;
    pendingProceed = null;
    closePopups();
    if (go) go();
  });

  function pickDrug(idx, existing) {
    var c = CATALOGUE[idx];
    var conflicts = conflictsFor(c);

    /* A same-product match in one named eye is not yet a conflict, because the
       side of this new entry has not been chosen. It is raised when the side is
       set, in the edit dialog, where it can be answered. */
    if (conflicts.length && conflicts[0].tier === 1 && routeTakesSide(c.route)
        && conflicts[0].entry.lat && conflicts[0].entry.lat !== 'Both') {
      conflicts = conflicts.slice(1);
    }
    if (conflicts.length) {
      openConflict(c, conflicts, function () { addFromCatalogue(c, true, existing); });
      return;
    }
    addFromCatalogue(c, false, existing);
  }

  function addFromCatalogue(c, overridden, existing) {
    if (c.allergy) {
      closePopups();
      alertBox('patient', '<strong>Allergy warning.</strong> This patient has a recorded allergy to ' + esc(c.drug)
        + '. In the real system this would require an explicit override with a reason. Not added.');
      return;
    }

    var e = mk({
      drug: c.drug, sub: c.sub, group: c.route === 'Eye' ? 'eye' : 'systemic',
      dose: c.unit === 'drop' ? '1' : '', unit: c.unit,
      /* No side is assumed. "Both" is a clinical statement, not a safe default,
         and guessing it here is how a patient ends up treated in an eye nobody
         chose. The edit dialog opens straight after this and asks. */
      freq: 'Once daily', route: c.route, lat: '',
      /* A drug the patient is already on did not start today, and we usually do
         not know when it did. Left blank rather than guessed at. */
      start: existing ? '' : TODAY, supply: null, existing: existing,
      source: existing ? addFrom() : 'started_here',
      history: [ h(nowStamp(), user().name, existing ? 'Recorded' : 'Started',
        (existing
          ? 'Recorded as already being taken, ' + addFromPhrase()
          : 'Added to medication record')
        + (overridden ? ', conflict acknowledged' : ''),
        hostEvent()) ]
    });
    STATE.entries.push(e);
    STATE.lastChanged = e.id;
    closePopups();
    render();
    alertBox('success', '<strong>' + esc(c.drug) + '</strong> '
      + (existing ? 'recorded as already being taken. ' : 'added. ')
      + (existing
          ? 'Source is ' + sourceOf(e).toLowerCase() + ' and the GP stays responsible for supplying it. '
            + 'Fill in the dose and frequency if you know them.'
          : 'Set the route, dose and frequency, say how long it is for, and tick Dispense if it needs an order.')
      + ' Nothing here commits until the examination is saved.'
      + (overridden ? ' The conflict you acknowledged is recorded in this drug\u2019s history.' : ''));
    openEdit(e);
  }

  /* Recording a whole list at once. Deliberately does not open the setup dialog
     for each drug: the point of this path is the patient who is on six things
     and we want them on the record before we know, or care, about exact doses.
     What we do know is that they are already taking them, which is what sets
     the source, the responsibility and the eye relevance. */
  function recordExistingBatch(idxs) {
    var added = [], blockedAllergy = [], blockedDup = [], advisories = [];

    idxs.forEach(function (i) {
      var c = CATALOGUE[i];
      if (c.allergy) { blockedAllergy.push(c.drug); return; }
      var cf = conflictsFor(c);
      /* Same rule as a single add: only an exact product match blocks, and only
         where the side cannot make it a different entry. */
      var lateralMaybe = cf.length && cf[0].tier === 1 && routeTakesSide(c.route)
        && cf[0].entry.lat && cf[0].entry.lat !== 'Both';
      if (cf.length && cf[0].tier === 1 && !lateralMaybe) { blockedDup.push(c.drug); return; }
      if (cf.length && cf[0].tier > 1) advisories.push(c.drug + ': ' + cf[0].detail);

      var e = mk({
        drug: c.drug, sub: c.sub, group: c.route === 'Eye' ? 'eye' : 'systemic',
        dose: '', unit: c.unit, freq: '', route: c.route, lat: '',
        start: '', supply: null, existing: true, source: addFrom(),
        history: [ h(nowStamp(), user().name, 'Recorded',
          'Recorded as already being taken, ' + addFromPhrase() + '. Dose and frequency not stated.',
          hostEvent()) ]
      });
      STATE.entries.push(e);
      added.push(c.drug);
    });

    closePopups();
    render();

    var msg = added.length
      ? '<strong>' + added.length + ' medication' + (added.length === 1 ? '' : 's')
        + '</strong> recorded as already being taken: ' + esc(added.join(', '))
        + '. Source is ' + addFromPhrase() + ' and the GP stays responsible. '
        + 'Dose and frequency are blank rather than guessed, and can be filled in on any of them later.'
      : '<strong>Nothing added.</strong>';
    if (blockedDup.length) msg += ' Already on the record, so not duplicated: ' + esc(blockedDup.join(', ')) + '.';
    if (blockedAllergy.length) msg += ' Blocked by a recorded allergy: ' + esc(blockedAllergy.join(', ')) + '.';
    if (advisories.length) msg += ' Added with an advisory: ' + esc(advisories.join('; ')) + '.';
    alertBox(added.length ? 'success' : 'patient', msg);
  }

  $('#proto-dup-edit').addEventListener('click', function () {
    closePopups();
    openEdit(findById(this.dataset.id));
  });

  /* Bring a planned start forward. One action, and the history has to read as
     exactly that rather than as a drug being deleted and another appearing. */
  $('#proto-dup-bringforward').addEventListener('click', function () {
    var e = findById(this.dataset.id);
    if (!e) return;
    var was = fmtDate(e.start);
    e.start = TODAY;
    e.status = 'current';
    e.history.push(h(nowStamp(), user().name, 'Planned start brought forward',
      'Was due to start ' + was + '. Started today instead. No second entry created.',
      hostEvent()));
    STATE.lastChanged = e.id;
    STATE.thisEvent[e.id] = STATE.thisEvent[e.id] || 'changed';
    closePopups();
    render();
    alertBox('success', '<strong>' + esc(e.drug) + '</strong> now starts today. '
      + 'The planned entry was brought forward rather than duplicated, so there is still one row and one history.');
    openEdit(e);
  });

  /* ---- pick lists ---- */

  /* OpenEyes writes a short closed list as a column of one-click buttons, not a
     dropdown: fieldset.btn-list with a hidden radio behind each label. Two clicks
     become one, and the whole list is readable without opening anything. Long
     tails such as the full route table stay behind a select, which is what IDG
     does too. */
  function btnList(id, values, current) {
    var name = 'p-' + id;
    $('#' + id).innerHTML = values.map(function (v) {
      var val = (typeof v === 'object') ? v.value : v;
      var lab = (typeof v === 'object') ? v.label : v;
      return '<label><input type="radio" name="' + name + '" value="' + esc(val) + '"'
        + (String(val) === String(current == null ? '' : current) ? ' checked' : '') + '>'
        + '<span class="li">' + esc(lab) + '</span></label>';
    }).join('');
  }

  /* The same closed-list idea laid out horizontally: the design system calls it
     "highlight as-button", and it is what IDG uses for the quick-set spans. */
  function btnRow(id, values, current) {
    var name = 'p-' + id;
    $('#' + id).innerHTML = values.map(function (v) {
      var val = (typeof v === 'object') ? v.value : v;
      var lab = (typeof v === 'object') ? v.label : v;
      return '<label class="highlight as-button inline"><input type="radio" name="' + name + '" value="' + esc(val) + '"'
        + (String(val) === String(current == null ? '' : current) ? ' checked' : '') + '>'
        + '<span class="btn">' + esc(lab) + '</span></label>';
    }).join('');
  }

  function btnVal(id) {
    var r = $('#' + id + ' input:checked');
    return r ? r.value : '';
  }

  function clearBtns(id) {
    $$('#' + id + ' input').forEach(function (i) { i.checked = false; });
  }

  var ROUTES = ['Eye', 'Oral', 'Intravitreal', 'Topical', 'Subconjunctival', 'Subcutaneous', 'Intravenous', 'Inhalation'];
  /* No "n/a". Where the route takes a side, n/a is not a clinical answer and
     offering it invites the invalid state that today's system then catches on
     saving the whole event. Where the route takes no side the control is not
     shown at all, so there is nothing for n/a to mean there either. */
  var LATERALITIES = [
    { value: 'Right', label: 'Right' },
    { value: 'Left',  label: 'Left' },
    { value: 'Both',  label: 'Right and Left' }
  ];
  var UNITS = ['drop', 'mg', 'microgram', 'ml', 'tablet(s)', 'capsule(s)', 'g', 'unit'];

  /* The buttons cover what an eye clinic uses. The rest of the lookup table sits
     behind a select, as IDG has it: picking from there adds the value as a
     button so the chosen one is visible alongside the common ones. */
  var ROUTES_ALL = ['Auricular', 'Buccal', 'Intracameral', 'Intramuscular', 'Intranasal',
    'Nasal', 'Orbital floor', 'Peribulbar', 'Rectal', 'Retrobulbar', 'Subretinal',
    'Subtenons', 'Sublingual', 'Transdermal', 'Vaginal'];
  var UNITS_ALL = ['ampoule', 'device', 'dose', 'insert', 'iu', 'piece', 'strip',
    'syringe', 'vial'];

  function withLongTail(common, current) {
    return (current && common.indexOf(current) === -1) ? common.concat([current]) : common;
  }

  function longTail(id, rest, common, current) {
    var sel = $('#' + id);
    var head = sel.options[0].textContent;
    sel.innerHTML = '<option value="">' + esc(head) + '</option>'
      + rest.filter(function (v) { return common.indexOf(v) === -1; })
        .map(function (v) { return '<option' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>'; })
        .join('');
  }
  var FREQUENCIES = [
    'Once daily', 'Twice daily', 'Three times daily', 'Four times daily',
    'Every 2 hours', 'At night', 'In the morning', 'Alternate days',
    'Once weekly', 'As required', 'Immediately (stat)'
  ];

  /* The quick-set buttons are the IDG pattern and they are faster than a duration
     dropdown for the lengths people actually use. They are still only a way of
     writing the date: the date is the stored fact, and the span is provenance. */
  var QUICK_DAYS = [1, 2, 3, 4, 5, 6, 7, 10, 14];
  var QUICK_PERIODS = [
    { value: '3 weeks', label: '3 wks' },
    { value: '1 month', label: '1 mth' },
    { value: '6 weeks', label: '6 wks' },
    { value: '3 months', label: '3 mths' }
  ];

  /* ---- edit ---- */

  /* True while the side showing in the dialog is the host event's suggestion
     rather than something the user chose. Cleared as soon as they touch it. */
  var sideFromHost = false;

  function openEdit(e) {
    editingId = e.id;
    /* A drug added inside an operation note opens with the operated eye already
       chosen, marked as coming from the note. Only on a new entry: an existing
       drug's side is a recorded fact and is not overwritten by context. */
    sideFromHost = false;
    if (!e.lat && routeTakesSide(e.route) && host().operatedEye && e.history.length <= 1) {
      e.lat = host().operatedEye;
      sideFromHost = true;
    }
    $('#proto-edit-title').innerHTML = latIcon(e) + ' ' + esc(e.drug) + ' <span class="fade">' + esc(e.sub) + '</span>';

    btnList('proto-edit-route', withLongTail(ROUTES, e.route), e.route);
    longTail('proto-edit-route-all', ROUTES_ALL, ROUTES, e.route);
    btnList('proto-edit-lat', LATERALITIES, e.lat);
    syncLaterality();
    btnList('proto-edit-unit', withLongTail(UNITS, e.unit), e.unit);
    longTail('proto-edit-unit-all', UNITS_ALL, UNITS, e.unit);
    btnList('proto-edit-freq', FREQUENCIES, e.freq);
    $('#proto-edit-dose').value = e.dose;
    $('#proto-edit-start').value = e.start;

    /* Quick-set writes the date; it is not itself stored. Re-opening the dialog
       shows the stored date with no span selected, so nothing recomputes behind
       the user's back. */
    btnRow('proto-quick-days', QUICK_DAYS.map(function (d) {
      return { value: d + ' days', label: '+' + d };
    }), '');
    btnRow('proto-quick-periods', QUICK_PERIODS, '');
    btnRow('proto-quick-anchor', [{ value: 'before_next_appointment', label: 'Stop before next appt' }],
      e.anchorDays != null ? 'before_next_appointment' : '');
    $('#proto-edit-anchordays').value = e.anchorDays || 7;
    $('#proto-edit-ongoing').checked = !e.end && e.anchorDays == null;
    $('#proto-edit-end').value = e.end || '';

    var cat = catFor(e.drug);
    $('#proto-edit-allergy').hidden = !cat.allergy;
    if (cat.allergy) {
      $('#proto-edit-allergy-name').textContent = e.drug;
      $('#proto-edit-allergy-ack').checked = false;
    }

    e.pendingIndication = e.indication;
    renderIndicationChips(e);

    var opts = supplyOptions();
    if (opts.indexOf(effectiveSupply(e)) === -1) opts = opts.concat([effectiveSupply(e)]);
    btnList('proto-edit-supply', opts.map(function (o) {
      return { value: o, label: RESPONSIBILITY[o] || o };
    }), effectiveSupply(e));
    $('#proto-edit-provider').value = e.supplyProvider || '';
    syncProviderField();

    /* Dispense is the order toggle, reachable from here as well as from the row,
       because "add it and prescribe it" is one thought. */
    $('#proto-edit-dispense-wrap').hidden = !canOrder(e);
    $('#proto-edit-dispense').checked = STATE.selected.indexOf(e.id) >= 0;

    $('#proto-edit-taper-on').checked = e.taper.length > 0;
    taperDraft = e.taper.map(function (t) { return Object.assign({}, t); });

    var note = $('#proto-edit-rx-note');
    var a = liveArtefactFor(e);
    if (a && isIssued(a)) {
      note.hidden = false;
      note.innerHTML = 'This medication is on <strong>' + esc(a.id) + '</strong>, which has been issued. Changing the record here will '
        + '<strong>not</strong> change that prescription, and the prescription cannot be edited. '
        + 'If the patient needs supply at the new directions, cancel and reissue from the Prescriptions tab.';
    } else if (a && a.status === 'signed') {
      note.hidden = false;
      note.innerHTML = 'This medication is on <strong>' + esc(a.id) + '</strong>, which is signed but not yet issued. '
        + 'The order was snapshotted when it was signed, so it will <strong>not</strong> change. '
        + 'It will be flagged as diverged from the record, including to the dispensing pharmacist. '
        + 'To make the order match, edit the order on the Prescriptions tab and sign it again.';
    } else if (a) {
      note.hidden = false;
      note.innerHTML = 'This medication is on <strong>' + esc(a.id) + '</strong>, an unsigned draft'
        + (a.requestedBy ? ' requested by ' + esc(a.requestedBy) : '') + '. '
        + 'Nothing has been attested, so the order will be signed from the record as it stands then. '
        + 'The change you are making will be shown to whoever signs it, beside what was asked for.';
    } else {
      note.hidden = true;
    }

    renderStopControl();
    openPopup('popup-edit');
  }

  /* The duration list, exactly as medication_duration holds it in the demo
     database, plus the one new entry. Note what is NOT here: no "3 months", which
     is the length most people reach for first. The list is a global lookup with a
     name and a display order, so a site can add that, but nobody has.

     `kind` is the proposal. Today there is no such column: stopDateFromDuration()
     special-cases the strings 'Once', 'Ongoing' and 'Other' by name and hands
     everything else to DateInterval::createFromDateString(), so the arithmetic
     depends on the display text. Rename "14 days" to "2 weeks (14d)" in admin and
     end dates silently stop being calculated. Adding an anchored option by name
     alone would fail the same way, which is why the typed column is its own CR. */
  var DURATIONS = [
    { name: '1 day',    kind: 'span' },
    { name: '2 days',   kind: 'span' },
    { name: '3 days',   kind: 'span' },
    { name: '4 days',   kind: 'span' },
    { name: '5 days',   kind: 'span' },
    { name: '6 days',   kind: 'span' },
    { name: '7 days',   kind: 'span' },
    { name: '10 days',  kind: 'span' },
    { name: '14 days',  kind: 'span' },
    { name: '3 weeks',  kind: 'span' },
    { name: '1 month',  kind: 'span' },
    { name: '6 weeks',  kind: 'span' },
    { name: 'Ongoing',  kind: 'ongoing' },
    { name: 'Once',     kind: 'once' },
    { name: 'Other',    kind: 'unspecified' },
    { name: 'Stop prior to next appointment', kind: 'before_next_appointment' }
  ];

  function durKind(name) {
    for (var i = 0; i < DURATIONS.length; i++) if (DURATIONS[i].name === name) return DURATIONS[i].kind;
    return 'unspecified';
  }

  function addSpan(iso, span) {
    var m = /^(\d+)\s+(day|week|month)/.exec(span || '');
    var d = new Date(iso + 'T00:00:00');
    if (!m) return iso;
    var n = parseInt(m[1], 10);
    if (m[2] === 'day') d.setDate(d.getDate() + n);
    if (m[2] === 'week') d.setDate(d.getDate() + n * 7);
    if (m[2] === 'month') d.setMonth(d.getMonth() + n);
    return isoOf(d);
  }

  /* Where a duration counts from. Not the start date, and not always today.

     A course set today on a drug the patient has been taking since June means a
     month from today, not a month from June, which is already in the past. A
     course set today on a drug that starts next week means a month from next
     week, because a month from today would end before the drug begins. So the
     anchor is whichever of the two is later: the moment these directions take
     effect. The dialog states which one it used, so a backdated start that was
     meant to count from the start is visible and correctable. */
  function durationAnchor(start) {
    return (start && start > TODAY) ? start : TODAY;
  }

  function anchorLabel(start) {
    return durationAnchor(start) === TODAY ? 'from today' : 'from ' + fmtDate(start);
  }

  /* Primary duration, then each taper step on top. Returns '' where no date can
     be worked out, which is Ongoing, Other and the anchored option.

     This is a suggestion for the date field, not a stored value. See the note on
     renderStopControl(). */
  function courseEnd(start, duration, taper) {
    var k = durKind(duration);
    if (k === 'ongoing' || k === 'unspecified' || k === 'before_next_appointment') return '';
    /* A single dose cannot have a reducing course, and the current
       stopDateFromDuration() agrees: it returns the start date for 'Once' before
       it looks at the tapers. */
    if (k === 'once') return start;
    var d = addSpan(durationAnchor(start), duration);
    for (var i = 0; i < (taper || []).length; i++) {
      var tk = durKind(taper[i].duration);
      if (tk === 'ongoing' || tk === 'unspecified' || tk === 'before_next_appointment') return '';
      if (tk !== 'once') d = addSpan(d, taper[i].duration);
    }
    return d;
  }

  /* The duration dropdown is a picker, not a stored value.

     What goes in the record is the stop date. The dropdown exists so that nobody
     has to do date arithmetic in their head, and the moment it is used it writes
     a date into the field beside it and stops being authoritative. This matters
     for a reason that is easy to miss: if the duration were stored and the date
     derived from it, then opening a drug next month and pressing save without
     touching anything would move the stop date, because the arithmetic would run
     again from a new today. A clinician who changed nothing would have changed
     something. Storing the date makes re-saving a no-op.

     It follows that the date has to be editable. An uneditable date would mean
     the dropdown is the only way to reach one, which is storing the duration by
     another name. Editing it clears the dropdown to "Other" rather than leaving a
     duration on screen that no longer describes the date. */
  /* Which of the three end states the dialog is in. Exactly one is true:
     ongoing (no end), anchored (no date yet, computed at the appointment), or a
     stored date. */
  function endMode() {
    if (btnVal('proto-quick-anchor')) return 'anchored';
    if ($('#proto-edit-ongoing').checked) return 'ongoing';
    return 'dated';
  }

  function applyQuickSet(span) {
    var start = $('#proto-edit-start').value || TODAY;
    $('#proto-edit-ongoing').checked = false;
    clearBtns('proto-quick-anchor');
    $('#proto-edit-end').value = addSpan(durationAnchor(start), span);
    renderStopControl();
  }

  function renderStopControl() {
    var mode = endMode();
    var start = $('#proto-edit-start').value || TODAY;
    var end = $('#proto-edit-end').value;

    $('#proto-edit-anchor-wrap').hidden = mode !== 'anchored';
    $('#proto-edit-end').disabled = mode !== 'dated';
    $('#proto-edit-taper-block').hidden = !$('#proto-edit-taper-on').checked;
    $('#proto-quick-note').textContent = 'Quick set end date from ' + anchorLabel(start).replace('from ', '');

    renderTaper();

    var note = $('#proto-edit-course-end');
    if (mode === 'ongoing') {
      note.textContent = taperDraft.length
        ? 'Reduces as below, then continues at the last step until someone stops it.'
        : 'No end date. The drug continues until someone stops it.';
    } else if (mode === 'anchored') {
      note.textContent = 'Recorded as a planned stop ' + ($('#proto-edit-anchordays').value || 0)
        + ' days before the next appointment. No date is worked out, because the appointment can move; '
        + 'the patient is told the relative instruction and the drug stays on the record until someone '
        + 'confirms it was stopped.';
    } else if (!end) {
      note.textContent = 'No stop date. Pick a quick set above, type a date, or tick Ongoing.';
    } else {
      note.textContent = 'Stops ' + fmtDate(end) + '. This date is what gets saved, so it will not '
        + 'move on its own if this drug is opened again later.';
    }
  }

  /* Quick set, ongoing and the anchored option are three ways of writing the same
     field, so each one clears the other two. */
  ['proto-quick-days', 'proto-quick-periods'].forEach(function (id) {
    document.addEventListener('change', function (ev) {
      if (ev.target.closest && ev.target.closest('#' + id)) {
        clearBtns(id === 'proto-quick-days' ? 'proto-quick-periods' : 'proto-quick-days');
        applyQuickSet(ev.target.value);
      }
    });
  });

  document.addEventListener('change', function (ev) {
    if (ev.target.closest && ev.target.closest('#proto-quick-anchor')) {
      clearBtns('proto-quick-days');
      clearBtns('proto-quick-periods');
      $('#proto-edit-ongoing').checked = false;
      $('#proto-edit-end').value = '';
      renderStopControl();
    }
  });

  $('#proto-edit-ongoing').addEventListener('change', function () {
    if (this.checked) {
      clearBtns('proto-quick-days');
      clearBtns('proto-quick-periods');
      clearBtns('proto-quick-anchor');
      $('#proto-edit-end').value = '';
    }
    renderStopControl();
  });

  $('#proto-edit-taper-on').addEventListener('change', function () {
    if (this.checked && !taperDraft.length) taperDraft = [];
    if (!this.checked) taperDraft = [];
    renderStopControl();
  });

  /* Typing a date by hand is authoritative: it drops any quick-set selection,
     because the span no longer describes what is in the field. */
  $('#proto-edit-end').addEventListener('change', function () {
    clearBtns('proto-quick-days');
    clearBtns('proto-quick-periods');
    if (this.value) $('#proto-edit-ongoing').checked = false;
    renderStopControl();
  });

  /* Laterality follows the route, because has_laterality is a property of the
     route and not a free choice. Switching to Oral does not silently keep a
     side on the record. */
  function syncLaterality() {
    var takes = routeTakesSide(btnVal('proto-edit-route'));
    /* Hidden rather than disabled. A greyed-out Right and Left under an oral
       drug is a question the user has to read and dismiss; absence says the
       same thing and says it faster. */
    $('#proto-edit-lat-wrap').hidden = !takes;
    if (!takes) clearBtns('proto-edit-lat');
    renderSideHint();
  }

  /* Where the host event supplied the side, say so, and stop saying it the
     moment the user picks for themselves: after that it is their answer. */
  function renderSideHint() {
    var hint = $('#proto-edit-lat-hint');
    var eye = host().operatedEye;
    var show = !$('#proto-edit-lat-wrap').hidden && eye && sideFromHost && btnVal('proto-edit-lat') === eye;
    hint.hidden = !show;
    $('#proto-edit-lat').classList.toggle('from-host', !!show);
    if (show) hint.innerHTML = '<i class="oe-i info small no-click"></i> Operated eye, from this operation note. Change it if that is not right.';
  }

  document.addEventListener('change', function (ev) {
    if (!ev.target.closest) return;
    if (ev.target.closest('#proto-edit-route')) syncLaterality();
    /* Touching the side makes it the user's answer, so the provenance mark goes. */
    if (ev.target.closest('#proto-edit-lat')) { sideFromHost = false; renderSideHint(); }
  });

  /* Picking from the long tail adds that value to the buttons and selects it, so
     the dialog never shows a chosen route or unit only inside a closed select. */
  [['proto-edit-route-all', 'proto-edit-route', ROUTES, true],
   ['proto-edit-unit-all', 'proto-edit-unit', UNITS, false]].forEach(function (p) {
    $('#' + p[0]).addEventListener('change', function () {
      if (!this.value) return;
      btnList(p[1], withLongTail(p[2], this.value), this.value);
      if (p[3]) syncLaterality();
    });
  });

  $('#proto-edit-start').addEventListener('change', renderStopControl);
  $('#proto-edit-anchordays').addEventListener('input', renderStopControl);

  $('#proto-stop-today').addEventListener('click', function () {
    clearBtns('proto-quick-days');
    clearBtns('proto-quick-periods');
    clearBtns('proto-quick-anchor');
    $('#proto-edit-ongoing').checked = false;
    $('#proto-edit-end').value = TODAY;
    renderStopControl();
  });

  $('#proto-edit-save').addEventListener('click', function () {
    var e = findById(editingId);
    var before = directions(e);
    var wantRoute = btnVal('proto-edit-route');
    var wantLat = routeTakesSide(wantRoute) ? btnVal('proto-edit-lat') : '';

    /* The side is required where the route takes one, and it is asked for here
       rather than being allowed through to fail on saving the event. This is
       `EventMedicationUse::validateLaterality()` moved to the point of the
       mistake instead of the end of the encounter. */
    if (routeTakesSide(wantRoute) && !wantLat) {
      alertBox('patient', '<strong>Which eye?</strong> ' + esc(e.drug) + ' is being given by a route that has a side, '
        + 'so one has to be chosen. Today OpenEyes lets this through and fails on saving the examination, which can be '
        + 'a long way from where the mistake was made.');
      return;
    }
    /* Now the side is known the uniqueness rule can actually be applied. Until
       this point a same-product match might have been the other eye. */
    var clash = conflictsFor(catFor(e.drug), e.id, wantLat).filter(function (x) { return x.tier === 1; })[0];
    if (clash) {
      alertBox('patient', '<strong>Already on the record.</strong> ' + esc(e.drug) + ' is active'
        + (clash.entry.lat ? ' for the ' + esc(clash.entry.lat.toLowerCase()) + ' eye' : '')
        + ', which overlaps the side chosen here. Change that entry rather than creating a second one.');
      return;
    }

    var sideChanged = e.lat !== wantLat;
    e.dose = $('#proto-edit-dose').value;
    e.unit = btnVal('proto-edit-unit');
    e.freq = btnVal('proto-edit-freq');
    e.route = wantRoute;
    e.lat = wantLat;
    /* Where the side was the host event's suggestion and was accepted rather than
       chosen, the history says so. Same provenance the set add records. */
    if (wantLat && sideFromHost && !sideChanged) {
      e.history.push(h(nowStamp(), user().name, 'Side taken from the operation note',
        wantLat + ', the operated eye', hostEvent()));
    }
    sideFromHost = false;
    e.start = $('#proto-edit-start').value;
    e.status = e.start > TODAY ? 'planned' : (e.status === 'held' ? 'held' : 'current');

    var newSupply = btnVal('proto-edit-supply');
    var newProvider = newSupply === 'other_provider'
      ? ($('#proto-edit-provider').value.trim() || null) : null;
    if (newSupply !== effectiveSupply(e) || newProvider !== (e.supplyProvider || null)) {
      var wasLabel = supplyLabel(e);
      e.supply = newSupply;
      e.supplyProvider = newProvider;
      e.history.push(h(nowStamp(), user().name, 'Responsibility to supply changed',
        wasLabel + ' to ' + (newSupply ? supplyLabel(e) : 'not stated'), hostEvent()));
    }

    /* Duration and taper are saved from the same dialog, so a fixed course or a
       reducing course is one interaction rather than two or three. */
    var beforeCourse = courseSummary(e);
    var mode = endMode();
    e.anchorDays = mode === 'anchored' ? parseInt($('#proto-edit-anchordays').value, 10) : null;
    e.taper = taperDraft.slice();
    /* The date from the field, not the arithmetic. A quick-set span is only how
       the date was arrived at, so it is not what gets stored. */
    e.end = mode === 'dated' ? $('#proto-edit-end').value : '';
    e.duration = mode === 'ongoing' ? 'Ongoing'
      : mode === 'anchored' ? 'Stop prior to next appointment'
      : (btnVal('proto-quick-days') || btnVal('proto-quick-periods') || 'Other');

    /* Choosing the anchored duration IS a planned stop. It writes the same record
       as the Stop action with relative timing, so there is one representation,
       one letter sentence and one confirmation, no matter which door it came
       through. A fixed span is left to lapse quietly; an anchored one cannot be,
       because nobody can compute the date and the patient has to act on a day we
       cannot predict. */
    if (e.anchorDays !== null) {
      var already = e.advice && e.advice.status === 'awaiting' && e.advice.anchor === 'before-appt'
        && e.advice.days === e.anchorDays;
      if (!already) {
        e.advice = { action: 'stop', anchor: 'before-appt', days: e.anchorDays, date: '',
          text: 'Stop taking ' + e.drug.toLowerCase() + ' ' + e.anchorDays
            + ' days before your next appointment.',
          reason: 'Course complete', by: user().name, at: nowStamp(),
          status: 'awaiting', outcomeNote: '' };
      }
    } else if (e.advice && e.advice.status === 'awaiting' && e.advice.reason === 'Course complete') {
      e.advice = null;
    }

    if (courseSummary(e) !== beforeCourse) {
      e.history.push(h(nowStamp(), user().name, 'Course set', courseSummary(e), hostEvent()));
    }

    // Indication is metadata, not directions, so it is recorded separately and
    // never disturbs a signature. It can move the drug between groups.
    if (e.pendingIndication !== e.indication) {
      var wasRelevant = isEyeRelevant(e);
      e.indication = e.pendingIndication;
      var dx = e.indication ? dxById(e.indication) : null;
      e.history.push(h(nowStamp(), user().name, 'Indication recorded',
        dx ? dx.name : 'Cleared', hostEvent()));
      if (isEyeRelevant(e) !== wasRelevant && !isOverridden(e)) {
        e.history.push(h(nowStamp(), user().name,
          isEyeRelevant(e) ? 'Became eye relevant' : 'No longer eye relevant',
          'Follows from the indication', hostEvent()));
      }
    }
    delete e.pendingIndication;

    var wantOrder = canOrder(e) && $('#proto-edit-dispense').checked;
    var at = STATE.selected.indexOf(e.id);
    if (wantOrder && at === -1) STATE.selected.push(e.id);
    if (!wantOrder && at >= 0) STATE.selected.splice(at, 1);

    var after = directions(e);
    var flagged = [];
    if (before !== after) {
      e.history.push(h(nowStamp(), user().name, 'Changed', after, hostEvent()));
      flagged = flagDivergence(e);
    }
    STATE.lastChanged = e.id;
    closePopups();
    render();

    if (before !== after) {
      var a = liveArtefactFor(e);
      var msg = '<strong>' + esc(e.drug) + '</strong> changed to ' + esc(after) + '.';
      if (flagged.length && a && a.status === 'signed') {
        msg += ' ' + esc(flagged.join(', ')) + ' was signed before this change, so it still says what was signed. '
          + 'It is now flagged as diverged, on the order, in the timeline and on the pharmacy worklist. '
          + 'To make the order match, edit the order and sign it again.';
      } else if (flagged.length) {
        msg += ' ' + esc(flagged.join(', ')) + ' has been issued and is unchanged, so it now shows as diverged from the record.';
      } else if (a && isDraft(a)) {
        msg += ' ' + esc(a.id) + ' is an unsigned draft, so it picked the change up.';
      }
      alertBox('', msg);
    }
  });

  /* ---- stop / hold / restart ---- */

  function toggleHold(e) {
    if (e.status === 'held') {
      e.status = e.start > TODAY ? 'planned' : 'current';
      var early = resumePending(e);
      e.history.push(h(nowStamp(), user().name, 'Resumed', directions(e), hostEvent()));
      if (early) {
        var due = resumeDate(early);
        early.status = 'done';
        early.resolvedBy = user().name;
        early.resolvedAt = nowStamp();
        e.history.push(h(nowStamp(), user().name, 'Resume plan closed',
          due ? 'Resumed here rather than on the planned date of ' + fmtDate(due)
              : 'Resumed here; no date had been set', hostEvent()));
        alertBox('', '<strong>' + esc(e.drug) + '</strong> resumed, and the planned resume is closed with it. '
          + 'Leaving it open would be waiting for something that has already happened.');
      }
    } else {
      e.status = 'held';
      e.history.push(h(nowStamp(), user().name, 'Held', 'Temporarily suspended, not stopped', hostEvent()));
    }
    STATE.lastChanged = e.id;
    render();
  }

  /* ---- adding several drugs at once ---- */

  var setMode = 'standard';

  /* The standard OpenEyes adder. One column, pick a row, then "Click to add".
     Deliberately not add-on-click: AdderDialog defaults returnOnSelect to false,
     and a set add is several drugs at once, so it should not fire on a stray click. */
  function openSetPicker(mode, btn) {
    setMode = mode;
    var pgd = mode === 'pgd';
    var list = pgd ? myPgds() : DRUG_SETS;

    $('#proto-set-header').textContent = pgd ? 'PGD name' : 'Set name';
    $('#proto-set-list').innerHTML = list.map(function (s) {
      var names = s.items.map(function (i) { return i.drug; });
      var dupes = names.filter(function (n) { return conflictsFor(catFor(n)).length > 0; });
      var allergic = names.filter(function (n) {
        return (CATALOGUE.filter(function (c) { return c.drug === n; })[0] || {}).allergy;
      });
      /* Real OpenEyes prepends an info icon on PGD rows whose tooltip lists the
         drugs. The same affordance is useful on a standard set, so both get one. */
      var tip = names.join(', ');
      return '<li data-id="' + s.id + '" data-label="' + esc(s.name) + '">'
        + '<i class="oe-i info small pad no-click" title="' + esc(tip) + '"></i>'
        + '<span class="auto-width">' + esc(s.name) + '</span>'
        + (allergic.length ? '<i class="oe-i allergy small no-click" title="Allergy: ' + esc(allergic.join(', ')) + '"></i>' : '')
        + (dupes.length ? '<i class="oe-i warning small no-click" title="Already on: ' + esc(dupes.join(', ')) + '"></i>' : '')
        + '</li>';
    }).join('') || '<li class="proto-empty">Nothing available to you</li>';

    var el = $('#adder-set');
    el.hidden = false;
    /* The real dialog is inserted after its open button and positioned against it. */
    if (btn) {
      var r = btn.getBoundingClientRect();
      el.style.bottom = (window.innerHeight - r.top + 8) + 'px';
      el.style.right = (window.innerWidth - r.right) + 'px';
    }
  }

  function closeSetPicker() {
    var el = $('#adder-set');
    el.hidden = true;
    $$('#proto-set-list li.selected').forEach(function (li) { li.classList.remove('selected'); });
  }

  /* What a set would do to this patient, worked out before anything changes.
     A set is rarely all-new or all-duplicate: the usual case is that the patient
     is already on one of its drugs, sometimes on different directions. Silently
     overwriting those is wrong, and silently skipping them is also wrong, because
     the clinician chose the set for a reason. So the overlap is resolved per drug. */
  /* `side` is the side chosen for this application of the set. It applies only to
     the items whose route takes one; a systemic drug in a post-op set stays
     sideless however the question was answered. */
  function planSetAdd(src, side) {
    var plan = { add: [], same: [], differs: [], allergy: [], needsSide: false };
    src.items.forEach(function (i) {
      var cat = CATALOGUE.filter(function (c) { return c.drug === i.drug; })[0] || {};
      var takesSide = routeTakesSide(i.route);
      if (takesSide) plan.needsSide = true;
      var lat = takesSide ? (side || '') : '';

      if (cat.allergy) { plan.allergy.push({ item: i, lat: lat }); return; }

      var cf = conflictsFor(cat, undefined, takesSide ? lat : undefined);
      var exact = cf.filter(function (x) { return x.tier === 1; })[0];
      if (!exact) {
        plan.add.push({ item: i, cat: cat, lat: lat, advisory: cf.length ? cf[0] : null });
        return;
      }
      /* On it already, on a side that overlaps the one proposed. The question is
         whether the set says anything different about how it is being taken. */
      var e = exact.entry;
      var diffs = [];
      if (String(e.dose) !== String(i.dose) || e.unit !== i.unit) {
        diffs.push({ field: 'Dose', now: e.dose + ' ' + e.unit, set: i.dose + ' ' + i.unit });
      }
      if (e.freq !== i.freq) diffs.push({ field: 'Frequency', now: e.freq, set: i.freq });
      /* A partial side overlap is a real difference: the patient is on it in one
         eye and the set is being applied to both. */
      if (lat && (e.lat || '') !== lat) diffs.push({ field: 'Side', now: e.lat || 'none', set: lat });
      if (i.route && e.route !== i.route) diffs.push({ field: 'Route', now: e.route, set: i.route });
      /* Compared on the stop date rather than the duration, because the date is
         what is stored and the duration is only how it was arrived at. A patient
         two weeks into a four-week course and a set that says four weeks agree on
         the duration and disagree by two weeks on when the drug stops, which is
         the difference that matters. */
      var setEnd = i.duration ? courseEnd(TODAY, i.duration, []) : null;
      if (i.duration && setEnd !== (e.end || '')) {
        diffs.push({
          field: 'Course',
          now: e.end ? 'stops ' + fmtDate(e.end) : 'ongoing',
          set: (setEnd ? 'stops ' + fmtDate(setEnd) : 'ongoing') + ' (' + i.duration + ')'
        });
      }
      var wanted = { dose: i.dose, unit: i.unit, freq: i.freq, route: i.route, lat: lat,
                     duration: i.duration || null, end: setEnd };
      if (diffs.length) plan.differs.push({ item: i, entry: e, lat: lat, diffs: diffs, wanted: wanted });
      else plan.same.push({ item: i, entry: e, lat: lat });
    });
    return plan;
  }

  var pendingSetPlan = null;

  /* The side is chosen once for the set and the consequences are recomputed as it
     changes, because which drugs are duplicates depends entirely on the answer.
     Opening with a side already picked but the consequences hidden would ask the
     user to predict them. */
  function openSetPlan(src, side) {
    var plan = planSetAdd(src, side);
    pendingSetPlan = { src: src, plan: plan, side: side };
    $('#proto-setplan-title').textContent = src.name;
    $('#proto-setplan-side').innerHTML = plan.needsSide ? sideChooserHtml(src, side) : '';

    var lead = [];
    if (plan.add.length) lead.push(plan.add.length + ' to add');
    if (plan.differs.length) lead.push(plan.differs.length + ' already recorded on different directions');
    if (plan.same.length) lead.push(plan.same.length + ' already recorded and unchanged');
    if (plan.allergy.length) lead.push(plan.allergy.length + ' blocked on a recorded allergy');

    var needSideFirst = plan.needsSide && !side;
    $('#proto-setplan-lead').textContent = needSideFirst
      ? 'This set contains drops, and a set never says which eye it is for. Choose a side to see what it would do.'
      : 'What this set would do: ' + lead.join(', ') + '.';
    $('#proto-setplan-go').disabled = needSideFirst;

    var html = '';
    if (needSideFirst) { $('#proto-setplan-body').innerHTML = ''; openPopup('popup-setplan'); return; }

    if (plan.differs.length) {
      html += '<h4>Already recorded, on different directions</h4>'
        + '<p class="proto-setplan-note">The set was written for a standard course and this patient has been '
        + 'set up differently. Neither answer is automatically right, so neither is applied by default.</p>';
      plan.differs.forEach(function (x, n) {
        html += '<div class="proto-setplan-row"><div class="proto-strong">' + esc(x.item.drug) + '</div>'
          + '<table class="standard proto-setplan-diff"><tbody>'
          + x.diffs.map(function (df) {
              return '<tr><td>' + esc(df.field) + '</td><td>' + esc(df.now)
                + '</td><td class="proto-setplan-arrow">&rarr;</td><td><strong>' + esc(df.set) + '</strong></td></tr>';
            }).join('')
          + '</tbody></table>'
          + choiceRow('setplan-' + n, [
              ['keep', 'Keep what is recorded'],
              ['take', 'Change to the set']
            ], 'keep')
          + '</div>';
      });
    }

    if (plan.add.length) {
      html += '<h4>Will be added</h4><ul class="proto-setplan-list">'
        + plan.add.map(function (x) {
            return '<li>' + esc(x.item.drug) + ' &mdash; ' + esc(setDirections(x.item, x.lat))
              + (routeTakesSide(x.item.route) ? '' : ' <span class="proto-setplan-aside">no side, not an eye route</span>')
              + (x.advisory ? ' <span class="proto-tag warn">' + esc(x.advisory.detail)
                  + ' as ' + esc(x.advisory.entry.drug) + '</span>' : '')
              + '</li>';
          }).join('') + '</ul>';
    }

    if (plan.same.length) {
      html += '<h4>Already recorded, nothing to do</h4><ul class="proto-setplan-list">'
        + plan.same.map(function (x) {
            return '<li>' + esc(x.item.drug) + ' &mdash; already on ' + esc(setDirections(x.item, x.lat)) + '</li>';
          }).join('') + '</ul>';
    }

    if (plan.allergy.length) {
      html += '<h4>Blocked on a recorded allergy</h4><ul class="proto-setplan-list">'
        + plan.allergy.map(function (x) {
            return '<li><i class="oe-i allergy small no-click"></i> ' + esc(x.item.drug)
              + ' &mdash; not added. Overriding an allergy is a deliberate act with a reason, '
              + 'not something a set add should do on your behalf.</li>';
          }).join('') + '</ul>';
    }

    $('#proto-setplan-body').innerHTML = html;
    openPopup('popup-setplan');
  }

  function sideChooserHtml(src, side) {
    var eye = host().operatedEye;
    var drops = src.items.filter(function (i) { return routeTakesSide(i.route); });
    var other = src.items.length - drops.length;

    var note;
    if (eye && side === eye) {
      note = '<i class="oe-i info small no-click"></i> Taken from the operated eye on this operation note. '
        + 'Change it here if the drops are not for the eye that was operated on.';
    } else if (eye) {
      note = '<i class="oe-i warning small no-click"></i> This operation note records the <strong>'
        + esc(eye.toLowerCase()) + '</strong> eye. You have chosen otherwise, which is allowed and will be recorded as your choice.';
    } else if (host().operatedEye === null && STATE.host.indexOf('op-') === 0) {
      note = '<i class="oe-i warning small no-click"></i> This operation note has no operated eye recorded, so nothing can be defaulted.';
    } else {
      note = 'A set does not carry a side, so this has to be chosen. It applies to the '
        + drops.length + ' drop' + (drops.length === 1 ? '' : 's')
        + (other ? ', and not to the ' + other + ' drug' + (other === 1 ? '' : 's') + ' taken another way' : '') + '.';
    }

    return '<div class="proto-setplan-side"><span class="proto-strong">Which eye</span>'
      + choiceRow('setside', [['Right', 'Right'], ['Left', 'Left'], ['Both', 'Both']], side || '')
      + '<p class="proto-setplan-note">' + note + '</p></div>';
  }

  /* Same button-list styling as the rest of the element, returned as markup
     because these rows are built before they are in the document. */
  function choiceRow(name, pairs, current) {
    return '<div class="proto-choice-row">' + pairs.map(function (p) {
      return '<label class="highlight as-button inline"><input type="radio" name="' + name
        + '" value="' + p[0] + '"' + (p[0] === current ? ' checked' : '') + '>'
        + '<span class="btn">' + esc(p[1]) + '</span></label>';
    }).join('') + '</div>';
  }

  function setDirections(i, lat) {
    var bits = [i.dose + (i.unit === 'drop' ? ' drop' + (i.dose === '1' ? '' : 's') : i.unit), i.freq, i.route];
    if (lat) bits.push(lat);
    if (i.duration) bits.push(i.duration);
    return bits.join(', ');
  }

  /* A set add is several individual drug actions, not a block. So the same
     uniqueness and allergy rules apply to each drug, and each is attributed. */
  function addSet(setId) {
    var pgd = setMode === 'pgd';
    var src = (pgd ? myPgds() : DRUG_SETS).filter(function (s) { return s.id === setId; })[0];

    /* Where the host event knows an operated eye, that is the opening answer. It
       is a default, not a decision: it is shown, labelled with where it came from,
       and can be changed before anything is written. Today's operation note applies
       it silently and after the fact, which is the behaviour this replaces. */
    var side = host().operatedEye || null;
    var plan = planSetAdd(src, side);

    /* Nothing to resolve: nobody has to be asked a side, nothing differs from what
       is recorded, nothing is blocked. Just do it, because a dialog that only ever
       says "yes, that worked" is a dialog people stop reading. */
    if (!plan.needsSide && !plan.differs.length && !plan.allergy.length) {
      applySetPlan(src, plan, {}, null); return;
    }
    openSetPlan(src, side);
  }

  /* choices maps the index of a differing drug to 'keep' or 'take'. */
  function applySetPlan(src, plan, choices, side) {
    var pgd = setMode === 'pgd';
    var added = [], changed = [], kept = [], advisories = [];
    /* Where the side came from is worth keeping. If the operated eye on the note
       is later corrected, this is what says which drugs inherited the old one. */
    var sideSource = !side ? null
      : (side === host().operatedEye ? 'operated eye on this operation note' : user().name);

    plan.add.forEach(function (x) {
      var i = x.item, cat = x.cat;
      var e = mk({
        drug: i.drug, sub: cat.sub || '', group: cat.group || 'eye',
        dose: i.dose, unit: i.unit, freq: i.freq, route: i.route, lat: x.lat,
        duration: i.duration || 'Ongoing', end: courseEnd(TODAY, i.duration || 'Ongoing', []),
        start: TODAY, supply: pgd ? 'hospital' : (i.responsibility || null),
        indication: cat.sugg || null,
        history: [ h(nowStamp(), user().name, 'Started',
          'Added from ' + (pgd ? 'PGD ' : 'set ') + src.name
          + (x.lat && sideSource ? '. Side ' + x.lat.toLowerCase() + ', from ' + sideSource : ''),
          hostEvent()) ]
      });
      if (pgd) e.pgd = src.name;
      STATE.entries.push(e);
      added.push(i.drug);
      if (x.advisory) advisories.push(i.drug + ' (' + x.advisory.detail + ' as ' + x.advisory.entry.drug + ')');
    });

    /* Taking the set's directions is a change to the existing drug, not a second
       row. It goes through the same primitive and the same history line as any
       other change, so the record reads "changed", not "added twice". */
    plan.differs.forEach(function (x, n) {
      if (choices['setplan-' + n] !== 'take') { kept.push(x.item.drug); return; }
      var e = x.entry, before = directions(e);
      e.dose = x.wanted.dose; e.unit = x.wanted.unit;
      e.freq = x.wanted.freq; e.route = x.wanted.route;
      if (x.wanted.lat) e.lat = x.wanted.lat;
      /* The course restarts from today, not from the original start date. Taking
         a set's four weeks means four weeks from now, which is the same rule the
         duration picker follows everywhere else. */
      if (x.wanted.duration) { e.duration = x.wanted.duration; e.end = x.wanted.end; }
      e.history.push(h(nowStamp(), user().name, 'Changed',
        directions(e) + ' (from ' + before + ', taken from ' + src.name + ')', hostEvent()));
      flagDivergence(e);
      changed.push(x.item.drug);
    });

    closePopups();
    render();

    var parts = [];
    if (added.length) parts.push('added ' + esc(added.join(', ')));
    if (changed.length) parts.push('changed ' + esc(changed.join(', ')) + ' to the set directions');
    if (kept.length) parts.push('left ' + esc(kept.join(', ')) + ' as recorded');
    if (plan.same.length) {
      parts.push('skipped ' + esc(plan.same.map(function (x) { return x.item.drug; }).join(', '))
        + ', already on the same directions');
    }
    var msg = '<strong>' + esc(src.name) + '</strong>: ' + (parts.length ? parts.join(', ') : 'nothing to do') + '. ';
    if (advisories.length) {
      msg += 'Added with an advisory: ' + esc(advisories.join('; ')) + '. Not blocked, for the same reason it is not '
        + 'blocked on a single add, but worth a look. ';
    }
    if (plan.allergy.length) {
      msg += 'Not added on a recorded allergy: '
        + esc(plan.allergy.map(function (x) { return x.item.drug; }).join(', ')) + '. ';
    }
    if (pgd) msg += 'Supply is set to the protocol, and each drug is attributed to you individually.';
    alertBox(added.length || changed.length ? 'success' : 'patient', msg);
  }

  $('#proto-host').addEventListener('change', function () {
    STATE.host = this.value;
    render();
    var eye = host().operatedEye;
    alertBox('', 'Now in <strong>' + esc(host().label) + '</strong>. '
      + (eye
          ? 'Adding a set that contains drops will open with <strong>' + esc(eye.toLowerCase())
            + '</strong> already chosen, taken from the operated eye, and say so. It is a default and can be changed.'
          : 'Nothing knows which eye here, so adding a set that contains drops will ask, with nothing pre-selected. '
            + 'A set carries a route but never a side.'));
  });

  $('#proto-institution').addEventListener('change', function () {
    STATE.institution = this.value;
    render();
    var i = inst();
    alertBox('', 'Now at <strong>' + esc(i.name) + '</strong>. The forms you can order on come from that institution\u2019s '
      + 'dispense condition mappings, so ' + (i.overprint ? 'FP10 is available' : 'FP10 is not available because overprint is off there')
      + ' and the default condition is &ldquo;' + esc(COND_LABELS[i.defaultCondition]) + '&rdquo;. '
      + 'Who supplies each drug is unaffected, because that is a fact about the patient rather than a local setting.');
  });

  /* ---- indication ---- */

  /* Indication uses the same one-click list as everything else on this dialog,
     drawn from the patient's own recorded diagnoses rather than a free search.
     The likely one is marked from the drug, so the common case is one click and
     the reader can see why it was offered. */
  function renderIndicationChips(e) {
    var cat = CATALOGUE.filter(function (c) { return c.drug === e.drug; })[0] || {};
    var chosen = e.pendingIndication != null ? e.pendingIndication : e.indication;
    var suggested = !chosen && cat.sugg ? cat.sugg : null;
    var opts = DIAGNOSES.map(function (d) {
      return { value: d.id, label: d.name + (d.eye ? '' : ' (systemic)') + (suggested === d.id ? ' \u2022 likely' : '') };
    }).concat([{ value: '', label: 'Not recorded' }]);
    btnList('proto-edit-indication', opts, chosen || '');
  }

  document.addEventListener('change', function (ev) {
    if (!ev.target.closest || !ev.target.closest('#proto-edit-indication')) return;
    var e = findById(editingId);
    if (e) e.pendingIndication = ev.target.value || null;
  });

  /* ---- advised future actions ---- */

  var advisingId = null, adviceTextTouched = false;

  /* Stop and Hold both open this. The clinician chooses the action they already
     understand and then says when; "not now" is what makes it a planned action,
     so there is no separate "advise" verb to learn. */
  function openAction(e, action) {
    advisingId = e.id;
    $('#proto-advise-title').textContent = action === 'stop' ? 'Stop medication' : 'Hold medication';
    $('#proto-advise-drug').textContent = e.drug + ' ' + e.sub;
    $('#proto-advise-action').value = action;
    $('#proto-advise-anchor').value = 'now';
    $('#proto-advise-days').value = 7;
    $('#proto-advise-date').value = '';
    /* A hold is thought about as a span, so the resume opens on the control that
       takes one. A stop has no second end. */
    $('#proto-resume-anchor').value = 'date';
    $('#proto-resume-date').value = addDays(TODAY, 14);
    $('#proto-resume-days').value = 7;
    btnRow('proto-resume-spans', RESUME_SPANS, 14);
    $('#proto-advise-reason').value = '';
    $('#proto-advise-text').value = '';
    adviceTextTouched = false;
    syncAdvise();
    openPopup('popup-advise');
  }

  function currentAdvice() {
    return {
      action: $('#proto-advise-action').value,
      anchor: $('#proto-advise-anchor').value,
      days: parseInt($('#proto-advise-days').value, 10) || 0,
      date: $('#proto-advise-date').value
    };
  }

  function currentResume() {
    var anchor = $('#proto-resume-anchor').value;
    if (!anchor) return null;
    return {
      anchor: anchor,
      days: parseInt($('#proto-resume-days').value, 10) || 0,
      date: $('#proto-resume-date').value
    };
  }

  /* The date the hold itself takes effect, which is what a span is measured from:
     "hold for two weeks from the first" ends on the fifteenth, not two weeks from
     today. Same reasoning as the duration anchor in the design model. */
  function holdEffective(a) {
    return a.anchor === 'now' ? TODAY : (adviceDate(a) || TODAY);
  }

  /* The preview is the point of this dialog: the clinician sees exactly what the
     patient and the letter will say, including the case where no date can be given. */
  function syncAdvise() {
    var a = currentAdvice();
    var now = a.anchor === 'now';
    $('#proto-advise-days-wrap').hidden = a.anchor !== 'before-appt' && a.anchor !== 'before-surgery';
    $('#proto-advise-days-wrap').firstChild.nodeValue =
      a.anchor === 'before-surgery' ? 'Days before surgery' : 'Days before';
    $('#proto-advise-date-wrap').hidden = a.anchor !== 'date';
    $('#proto-advise-text-wrap').hidden = now && a.action === 'stop';
    $('#proto-advise-title').textContent = (a.action === 'stop' ? 'Stop' : 'Hold') + ' medication';
    var e = findById(advisingId);

    var r = currentResume();
    $('#proto-resume-block').hidden = a.action !== 'hold';
    $('#proto-resume-date-wrap').hidden = !r || r.anchor !== 'date';
    $('#proto-resume-days-wrap').hidden = !r || r.anchor !== 'before-appt';
    
    $('#proto-resume-quickset').hidden = !r || r.anchor !== 'date';

    if (a.action === 'hold') {
      var eff = holdEffective(a);
      $('#proto-resume-note').textContent = a.anchor === 'now'
        ? 'Measured from today, because the hold starts today.'
        : 'Measured from ' + (adviceDate(a) ? fmtDate(eff) : 'the day the hold takes effect')
          + ', not from today, so the span means what it says.';
      /* A typed date is the decision; the span that no longer matches it must not
         stay lit, or the screen shows two claims and only one is stored. */
      var sel = $('#proto-resume-spans input:checked');
      if (sel && r && r.anchor === 'date' && r.date !== addDays(eff, parseInt(sel.value, 10))) sel.checked = false;
      var resumeMsg = r
        ? esc(resumeWording(r)) + '. ' + (resumeDate(r)
            ? 'That is a planned action in its own right, and somebody has to confirm whether the patient actually restarted.'
            : 'No date can be given yet, so the instruction carries the rule in words.')
        : '<strong>No resume date.</strong> The drug stays held until someone decides, and the row will say so rather than implying a plan that does not exist.';
      if (now) {
        $('#proto-advise-preview').innerHTML = 'The hold takes effect <strong>immediately</strong>. '
          + esc(e.drug) + ' will show as on hold from today. ' + resumeMsg;
        syncAdviceText(a, r, e);
        return;
      }
      var res0 = adviceDate(a);
      $('#proto-advise-preview').innerHTML = '<strong>' + esc(adviceWording(a)) + '.</strong> '
        + (res0 ? 'The letter and the patient instruction will carry this date, and it will be recalculated if the appointment moves. '
                : 'No date can be given yet, so the relative wording is used. ')
        + esc(e.drug) + ' stays on the record as being taken until someone confirms what happened. ' + resumeMsg;
      syncAdviceText(a, r, e);
      return;
    }

    if (now) {
      $('#proto-advise-preview').innerHTML = 'This takes effect <strong>immediately</strong>. '
        + esc(e.drug) + ' will show as stopped from today.';
      return;
    }

    var resolved = adviceDate(a);
    var msg = '<strong>' + esc(adviceWording(a)) + '.</strong> ';
    msg += resolved
      ? 'The letter and the patient instruction will carry this date, and it will be recalculated if the appointment moves.'
      : 'No date can be given yet, so the letter and the patient instruction will use the relative wording and the date will appear once the appointment is booked.';
    msg += ' ' + esc(e.drug) + ' stays on the record as being taken until someone confirms what happened.';
    $('#proto-advise-preview').innerHTML = msg;
    syncAdviceText(a, null, e);
  }

  /* One sentence covering both ends, which is the argument for the paired model:
     what the patient needs to hear is "stop on the first, restart on the
     fifteenth", and a stop plus a future start cannot produce that. */
  function syncAdviceText(a, r, e) {
    if (adviceTextTouched) return;
    var whenWords = a.anchor === 'now' ? 'now'
      : a.anchor === 'at-appt' ? 'at your next appointment'
      : a.anchor === 'at-surgery' ? 'on the day of your operation'
      : a.anchor === 'before-surgery' ? a.days + ' days before your operation'
      : a.anchor === 'date' ? (a.date ? 'on ' + fmtDate(a.date) : 'on the date given')
      : a.days + ' days before your next appointment';
    var txt = (a.action === 'stop' ? 'Stop taking ' : 'Pause ') + e.drug.toLowerCase() + ' ' + whenWords;
    if (a.action === 'hold') {
      if (!r) {
        txt += ', and do not restart until we tell you';
      } else if (r.anchor === 'date' && r.date) {
        txt += ', and start again on ' + fmtDate(r.date);
      } else if (r.anchor === 'at-appt') {
        txt += ', and start again after your next appointment';
      } else if (r.anchor === 'before-appt') {
        txt += ', and start again ' + r.days + ' days before your next appointment';
      } else {
        txt += ', and start again on the date given';
      }
    }
    $('#proto-advise-text').value = txt + '.';
  }

  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'proto-advise-text') adviceTextTouched = true;
  });

  ['proto-resume-anchor', 'proto-resume-days', 'proto-resume-date'].forEach(function (id) {
    document.addEventListener('change', function (ev) { if (ev.target.id === id) syncAdvise(); });
    document.addEventListener('input', function (ev) { if (ev.target.id === id) syncAdvise(); });
  });

  /* The span buttons write a date rather than storing a span, for the reason in
     the design model: a stored span is recomputed against a moving today, and
     the stop date then changes with nobody having decided it. */
  var RESUME_SPANS = [
    { value: 7, label: '1 wk' }, { value: 14, label: '2 wks' }, { value: 21, label: '3 wks' },
    { value: 28, label: '4 wks' }, { value: 42, label: '6 wks' }, { value: 84, label: '3 mths' }
  ];

  document.addEventListener('change', function (ev) {
    if (ev.target.name !== 'p-proto-resume-spans') return;
    $('#proto-resume-anchor').value = 'date';
    $('#proto-resume-date').value = addDays(holdEffective(currentAdvice()), parseInt(ev.target.value, 10));
    syncAdvise();
  });

  ['proto-advise-action', 'proto-advise-anchor', 'proto-advise-days', 'proto-advise-date'].forEach(function (id) {
    document.addEventListener('change', function (ev) { if (ev.target.id === id) syncAdvise(); });
    document.addEventListener('input', function (ev) { if (ev.target.id === id) syncAdvise(); });
  });

  $('#proto-advise-save').addEventListener('click', function () {
    var e = findById(advisingId);
    var a = currentAdvice();

    var r = a.action === 'hold' ? currentResume() : null;
    if (r && !validResume(a, r)) return;

    /* A date that has already passed is a record of something that happened, not
       a plan for something that might. Recording that a patient came off a drug
       in March is the ordinary way previous medication gets onto the record, and
       it must not produce "not yet confirmed": there is nothing to confirm and
       nobody to ask. Only a future date is advice. */
    var effective = a.anchor === 'now' ? TODAY
      : (a.anchor === 'date' && a.date && a.date <= TODAY ? a.date : null);

    if (effective) {
      var back = effective < TODAY;
      var reason = $('#proto-advise-reason').value;
      if (a.action === 'stop') {
        e.status = 'stopped';
        e.end = effective;
        e.stopReason = reason || 'Stopped';
        e.supply = '';
        e.history.push(h(nowStamp(), user().name, back ? 'Stopped, recorded later' : 'Stopped',
          e.stopReason + (back ? '. Took effect ' + fmtDate(effective) : ''), hostEvent()));
      } else {
        e.status = 'held';
        e.heldSince = effective;
        e.history.push(h(nowStamp(), user().name, back ? 'Held, recorded later' : 'Held',
          (reason || 'Temporarily suspended, not stopped')
            + (back ? '. Took effect ' + fmtDate(effective) : ''), hostEvent()));
        setResumePlan(e, r, $('#proto-advise-text').value, effective);
      }
      STATE.lastChanged = e.id;
      closePopups();
      render();
      alertBox('', '<strong>' + esc(e.drug) + '</strong> '
        + (a.action === 'stop' ? 'stopped' : 'put on hold')
        + (back ? ' with effect from ' + fmtDate(effective)
                + '. That date is in the past, so this is a record of what happened rather than a plan, '
                + 'and there is nothing to confirm.' : '.')
        + (a.action === 'stop' ? ' Any prescription already issued for it remains on the record as an artefact.'
           : (r ? ' ' + resumeWording(r) + (resumeDate(r) && resumeDate(r) <= TODAY ? '.'
                  : ', which is a planned action: somebody has to confirm whether the patient restarted.')
                : ' No resume date was set, so it stays held until someone decides.')));
      return;
    }

    a.text = $('#proto-advise-text').value;
    a.reason = $('#proto-advise-reason').value;
    a.by = user().name;
    a.at = nowStamp();
    a.status = 'awaiting';
    a.outcomeNote = '';
    e.advice = a;
    if (a.action === 'hold') setResumePlan(e, r, a.text);
    e.history.push(h(a.at, a.by, a.action === 'stop' ? 'Stop planned' : 'Hold planned',
      adviceWording(a) + '. Not yet actioned', hostEvent()));
    STATE.lastChanged = e.id;
    closePopups();
    render();
    alertBox('', '<strong>' + esc(e.drug) + '</strong> is planned to ' + (a.action === 'stop' ? 'stop' : 'be held')
      + ', but has not been yet, so it still shows as being taken. It will appear on the letter and in the patient '
      + 'instructions, and it will be raised for confirmation at the next visit.');
  });

  /* A pause cannot end before it starts. Validation rather than judgement. */
  function validResume(a, r) {
    var start = holdEffective(a), end = resumeDate(r);
    if (r.anchor === 'date' && !r.date) {
      alertBox('error', 'Give a date to resume on, or choose "Not yet decided".');
      return false;
    }
    if (end && end <= start) {
      alertBox('error', 'The resume date has to be after the hold takes effect. '
        + 'A pause cannot end before it starts.');
      return false;
    }
    return true;
  }

  /* Stored as its own planned action, with primitive "resume". Setting it to null
     is a decision too: the row then says the resume is undecided rather than
     saying nothing, which is what makes an open-ended hold findable. */
  /* When the hold started matters to the reader once it can be backdated, so the
     row says it rather than making them open the history. */
  function heldWording(e) {
    return e.heldSince && e.heldSince < TODAY ? 'Held since ' + fmtDate(e.heldSince) + '.' : 'Held.';
  }

  function setResumePlan(e, r, text, heldFrom) {
    if (!r) {
      e.resume = null;
      e.history.push(h(nowStamp(), user().name, 'Resume not scheduled',
        'Held with no resume date. To be decided at review', hostEvent()));
      return;
    }
    /* Same rule as the hold itself. A resume date that has already passed
       describes a pause the patient has already come out of, so record both ends
       and leave the drug current, rather than asking someone to confirm a plan
       whose date went by. */
    var when = resumeDate(r);
    if (when && when <= TODAY) {
      e.status = 'current';
      e.resume = null;
      e.history.push(h(nowStamp(), user().name, 'Resumed, recorded later',
        'Held' + (heldFrom ? ' from ' + fmtDate(heldFrom) : '') + ', restarted ' + fmtDate(when), hostEvent()));
      return;
    }
    e.resume = {
      anchor: r.anchor, days: r.days, date: r.date,
      text: text, by: user().name, at: nowStamp(), status: 'awaiting', outcomeNote: ''
    };
    e.history.push(h(nowStamp(), user().name, 'Resume planned',
      resumeWording(e.resume) + '. Not yet actioned', hostEvent()));
  }

  /* Confirmation is its own act: a different person, at a different time, and the
     answer can be no. Only this converts advice into a change to the record. */
  var confirmingId = null, confirmingKind = 'advice';

  function openConfirm(e, kind) {
    confirmingId = e.id;
    confirmingKind = kind || ((e.advice && e.advice.status === 'awaiting') ? 'advice' : 'resume');
    var p = confirmingKind === 'resume' ? e.resume : e.advice;
    var words = confirmingKind === 'resume' ? resumeWording(p) : adviceWording(p);
    var when = confirmingKind === 'resume' ? resumeDate(p) : adviceDate(p);
    $('#proto-confirm-drug').textContent = e.drug + ' ' + e.sub;
    $('#proto-confirm-advice').innerHTML = esc(words) + '.<br>Planned by ' + esc(p.by)
      + ' on ' + esc(fmtWhen(p.at)) + '. Patient was told: &ldquo;' + esc(p.text || '') + '&rdquo;'
      + (confirmingKind === 'resume'
          ? '<br><span class="proto-drug-sub">Answering no leaves the drug held, which is the point: '
            + 'a patient who never restarted is off treatment and the record should say so.</span>' : '');
    $('#proto-confirm-date').value = when || '';
    $('#proto-confirm-note').value = '';
    openPopup('popup-confirm');
  }

  function resolveAdvice(outcome) {
    if (confirmingKind === 'resume') return resolveResume(outcome);
    var e = findById(confirmingId);
    var a = e.advice;
    var when = $('#proto-confirm-date').value || TODAY;
    a.outcomeNote = $('#proto-confirm-note').value;
    a.status = outcome;
    a.resolvedBy = user().name;
    a.resolvedAt = nowStamp();

    var msg;
    if (outcome === 'done') {
      if (a.action === 'stop') {
        e.status = 'stopped';
        e.stopReason = 'Stopped as advised';
        e.end = when;
      } else {
        e.status = 'held';
      }
      e.history.push(h(a.resolvedAt, a.resolvedBy,
        a.action === 'stop' ? 'Confirmed stopped' : 'Confirmed held',
        'Planned ' + fmtDate(adviceDate(a) || when) + ', actually ' + fmtDate(when)
          + (a.outcomeNote ? '. ' + a.outcomeNote : ''), hostEvent()));
      msg = 'Confirmed. The plan has now become a change to the record, dated when it actually happened rather than when it was planned.';
    } else if (outcome === 'not-done') {
      e.history.push(h(a.resolvedAt, a.resolvedBy, 'Planned change not done',
        'Patient did not ' + (a.action === 'stop' ? 'stop' : 'hold')
          + (a.outcomeNote ? '. ' + a.outcomeNote : ''), hostEvent()));
      msg = 'Recorded as not done. The medication is unchanged, and the fact that it did not happen is now on the record, '
        + 'which is the part that matters if a decision was going to be made on the assumption that it had been.';
      /* The hold never happened, so there is nothing to resume. Leaving the
         resume waiting would be waiting for an event that cannot occur. */
      if (a.action === 'hold' && resumePending(e)) {
        e.resume.status = 'na';
        e.resume.resolvedBy = a.resolvedBy;
        e.resume.resolvedAt = a.resolvedAt;
        e.history.push(h(a.resolvedAt, a.resolvedBy, 'Resume withdrawn',
          'The hold was not done, so there is nothing to resume', hostEvent()));
        msg += ' The planned resume has been withdrawn, because there is nothing to restart.';
      }
    } else {
      e.history.push(h(a.resolvedAt, a.resolvedBy, 'Plan withdrawn',
        'No longer applicable' + (a.outcomeNote ? '. ' + a.outcomeNote : ''), hostEvent()));
      msg = 'Withdrawn. The plan is closed without changing the medication.';
    }
    STATE.lastChanged = e.id;
    closePopups();
    render();
    alertBox(outcome === 'done' ? 'success' : '', '<strong>' + esc(e.drug) + '</strong>. ' + msg);
  }

  function resolveResume(outcome) {
    var e = findById(confirmingId);
    var r = e.resume;
    var when = $('#proto-confirm-date').value || TODAY;
    r.outcomeNote = $('#proto-confirm-note').value;
    r.status = outcome;
    r.resolvedBy = user().name;
    r.resolvedAt = nowStamp();

    var msg;
    if (outcome === 'done') {
      e.status = e.start > TODAY ? 'planned' : 'current';
      e.history.push(h(r.resolvedAt, r.resolvedBy, 'Confirmed resumed',
        'Planned ' + fmtDate(resumeDate(r) || when) + ', actually ' + fmtDate(when)
          + (r.outcomeNote ? '. ' + r.outcomeNote : ''), hostEvent()));
      msg = 'Resumed. The hold is cleared and the drug is active again, dated when the patient actually restarted. '
        + 'Nothing has been ordered: whether a fresh prescription is needed is a decision on the record.';
    } else if (outcome === 'not-done') {
      e.history.push(h(r.resolvedAt, r.resolvedBy, 'Resume not done',
        'Patient has not restarted' + (r.outcomeNote ? '. ' + r.outcomeNote : ''), hostEvent()));
      msg = 'Recorded as not restarted. The drug stays held, and the record now says the patient is off it rather than '
        + 'leaving everyone to assume they went back on it.';
    } else {
      e.history.push(h(r.resolvedAt, r.resolvedBy, 'Resume withdrawn',
        'No longer applicable' + (r.outcomeNote ? '. ' + r.outcomeNote : ''), hostEvent()));
      msg = 'Withdrawn. The plan is closed and the drug stays as it is.';
    }
    STATE.lastChanged = e.id;
    closePopups();
    render();
    alertBox(outcome === 'done' ? 'success' : '', '<strong>' + esc(e.drug) + '</strong>. ' + msg);
  }

  $('#proto-confirm-yes').addEventListener('click', function () { resolveAdvice('done'); });
  $('#proto-confirm-no').addEventListener('click', function () { resolveAdvice('not-done'); });
  $('#proto-confirm-na').addEventListener('click', function () { resolveAdvice('na'); });

  /* Relevance is not a clinical change to the drug. It changes where the drug is
     shown and whether ophthalmic shortcodes pick it up. The override is cleared,
     not inverted, when it returns to matching the drug-set default. */
  function toggleRelevance(e) {
    var next = !isEyeRelevant(e);
    e.relevantOverride = (next === defaultRelevant(e)) ? null : next;
    e.history.push(h(nowStamp(), user().name,
      next ? 'Marked eye relevant' : 'Marked not eye relevant',
      e.relevantOverride === null
        ? 'Override cleared, back to the drug-set default'
        : 'Override of the drug-set default for this patient',
      hostEvent()));
    STATE.lastChanged = e.id;
    render();
    alertBox('', '<strong>' + esc(e.drug) + '</strong> is now '
      + (next ? 'marked eye relevant' : 'not marked eye relevant')
      + (e.relevantOverride === null
          ? ', which matches the drug-set default, so no override is stored.'
          : ' for this patient. The drug-set default is unchanged; only the override is stored.')
      + ' Nothing clinical about the medication has changed, but it moves group and changes which shortcodes pick it up.');
  }

  /* Restarting a stopped drug begins a new thread rather than reviving the old
     one. Reviving it would have to move the start date to today, which erases
     when the first course actually ran, and would leave one history in which
     "stopped" and "started" alternate with nothing saying which course a later
     dose change belongs to. Two threads keep both courses intact and truthful,
     and the history popup offers them side by side. The link between them is the
     source entry, which is the same chain used everywhere else in the model. */
  function restart(e) {
    var n = mk({
      drug: e.drug, sub: e.sub, group: e.group, dose: e.dose, unit: e.unit,
      freq: e.freq, route: e.route, lat: e.lat, indication: e.indication,
      supply: e.supply, supplyProvider: e.supplyProvider,
      /* The reducing schedule is not carried over. Its steps are dated, and
         dates from the first course mean nothing in the second, so rebasing them
         would be a guess at a prescribing decision. */
      duration: e.duration, taper: [],
      start: TODAY, sourceEntryId: e.id, existing: false,
      history: [h(nowStamp(), user().name, 'Restarted',
        directions(e) + '. Earlier course ran ' + fmtDate(e.start) + ' to ' + fmtDate(e.end)
          + (e.stopReason ? ', stopped: ' + e.stopReason : ''), hostEvent())]
    });
    n.pending = 'added';
    STATE.entries.push(n);
    e.history.push(h(nowStamp(), user().name, 'Restarted as a new course',
      'This course stays as it was. The drug continues on a new thread from ' + fmtDate(TODAY), hostEvent()));
    STATE.lastChanged = n.id;
    render();
    alertBox('', '<strong>' + esc(e.drug) + '</strong> restarted as a new course from today. '
      + 'The earlier course keeps its own dates and history rather than being overwritten, and the two are '
      + 'offered side by side under History.'
      + (e.taper.length ? ' The reducing schedule was not carried over, because its dates belonged to the '
          + 'first course. Set it again if it still applies.' : ''));
  }

  /* ---- reconciling a draft against the record ---- */

  /* Keep does not have to be clicked to sign: the record's version is what gets
     snapshotted either way. Clicking it records that a prescriber looked at the
     difference and decided, which is the part worth having in the history. */
  function rxKeep(id, entryId) {
    var a = rxById(id);
    var e = findById(entryId);
    if (!a || !e) return;
    a.kept = a.kept || {};
    a.kept[entryId] = { by: user().name, at: nowStamp(), directions: directions(e) };
    e.history.push(h(nowStamp(), user().name, 'Reviewed', directions(e),
      a.id + ': kept the recorded directions rather than the ones requested'));
    render();
    alertBox('', '<strong>' + esc(e.drug) + '</strong>: keeping what the record says. '
      + 'The request stays in the order as what was originally asked for.');
  }

  function rxRestore(id, entryId) {
    var a = rxById(id);
    var e = a ? restoreRequested(a, entryId) : null;
    if (!e) return;
    STATE.lastChanged = e.id;
    render();
    alertBox('', '<strong>' + esc(e.drug) + '</strong> set back to the requested directions, '
      + esc(directions(e)) + '. This is a change to the medication record, in your name, and it is '
      + 'not saved until the event is: signing the order commits it in the same transaction.');
  }

  function rxRestart(id, entryId) {
    var a = rxById(id);
    var e = findById(entryId);
    if (!a || !e) return;
    restart(e);
    alertBox('', '<strong>' + esc(e.drug) + '</strong> restarted, so it is back on the order. '
      + 'It was stopped after the order was prepared, which is why it needed a decision rather than '
      + 'being prescribed quietly.');
  }

  /* ---- taper ---- */

  function courseSummary(e) {
    var steps = e.taper.length ? ' after ' + e.taper.length + ' reducing step' + (e.taper.length === 1 ? '' : 's') : '';
    var k = durKind(e.duration);
    if (k === 'before_next_appointment') return 'Stops ' + e.anchorDays + ' days before the next appointment';
    if (k === 'ongoing') return e.taper.length ? 'Ongoing, reducing over ' + e.taper.length + ' steps' : 'Ongoing';
    if (k === 'once') return 'Single dose on ' + fmtDate(e.start);
    if (k === 'unspecified') return 'Other, no end date calculated';
    return 'For ' + e.duration + ', finishing ' + fmtDate(e.end) + steps;
  }

  /* Taper steps draw on the same lookup, which is what ophdrprescription_item_taper
     already does through duration_id. The anchored option is not offered on a step:
     an intermediate step that ends relative to an appointment cannot be followed by
     another step, because nothing after it has a start. */
  function taperDurationOptions(sel) {
    return DURATIONS.filter(function (d) { return d.kind !== 'before_next_appointment'; })
      .map(function (d) {
        return '<option' + (d.name === sel ? ' selected' : '') + '>' + esc(d.name) + '</option>';
      }).join('');
  }

  function renderTaper() {
    var body = $('#proto-taper-body');
    if (!taperDraft.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="proto-empty">No reducing course. The directions above apply throughout.</div></td></tr>';
      return;
    }
    body.innerHTML = taperDraft.map(function (t, i) {
      return '<tr>'
        + '<td><input type="date" value="' + t.from + '" data-tap="from" data-i="' + i + '"></td>'
        + '<td><input type="text" value="' + esc(t.dose) + '" size="4" data-tap="dose" data-i="' + i + '"></td>'
        + '<td><input type="text" value="' + esc(t.freq) + '" data-tap="freq" data-i="' + i + '"></td>'
        + '<td><select data-tap="duration" data-i="' + i + '">' + taperDurationOptions(t.duration) + '</select></td>'
        + '<td><button type="button" data-tap="del" data-i="' + i + '">Remove</button></td></tr>';
    }).join('');
  }

  /* The steps run on from each other, so the last step's end is the end of the
     course. Where the dialog is in dated mode that date is written into the end
     field, because the end field is the thing that gets saved. */
  function taperEnd() {
    var at = $('#proto-edit-start').value || TODAY;
    taperDraft.forEach(function (t) { at = addSpan(t.from > at ? t.from : at, t.duration); });
    return at;
  }

  function taperChanged() {
    if (taperDraft.length && endMode() === 'dated') $('#proto-edit-end').value = taperEnd();
    renderStopControl();
  }

  $('#proto-taper-add').addEventListener('click', function () {
    var from = taperDraft.length ? taperEnd()
      : ($('#proto-edit-end').value || $('#proto-edit-start').value || TODAY);
    taperDraft.push({ from: from, dose: '1', freq: 'Twice daily', duration: '7 days' });
    taperChanged();
  });

  $('#proto-taper-body').addEventListener('input', function (ev) {
    var k = ev.target.dataset.tap, i = ev.target.dataset.i;
    if (k && k !== 'del') { taperDraft[i][k] = ev.target.value; taperChanged(); }
  });
  $('#proto-taper-body').addEventListener('change', function (ev) {
    var k = ev.target.dataset.tap, i = ev.target.dataset.i;
    if (k && k !== 'del') { taperDraft[i][k] = ev.target.value; taperChanged(); }
  });
  $('#proto-taper-body').addEventListener('click', function (ev) {
    if (ev.target.dataset.tap === 'del') { taperDraft.splice(ev.target.dataset.i, 1); taperChanged(); }
  });

  /* ---- history ---- */

  /* History belongs to the thread, not to the drug. A thread is one drug on one
     side, running from the day it started to the day it stopped, and the same
     drug can have several: one in each eye, on different regimens, plus earlier
     courses that were stopped and later begun again. Hanging the history off the
     drug would merge all of those into one list in which nothing says which eye
     or which course a line refers to, and merging the two eyes is the specific
     mistake the current system makes. So the popup shows one thread at a time
     and names it, and offers the others rather than hiding them. */
  function threadsFor(e) {
    return STATE.entries.filter(function (x) { return x.drug === e.drug; })
      .sort(function (a, b) {
        var ao = a.status === 'stopped' ? 1 : 0, bo = b.status === 'stopped' ? 1 : 0;
        if (ao !== bo) return ao - bo;
        return (b.start || '').localeCompare(a.start || '');
      });
  }

  function threadLabel(e) {
    var side = e.route !== 'Eye' ? 'Systemic'
      : e.lat === 'Both' ? 'Both eyes' : e.lat ? e.lat + ' eye' : 'Side not recorded';
    var state = e.status === 'stopped' ? 'stopped ' + fmtDate(e.end)
      : e.status === 'held' ? 'held'
      : e.status === 'planned' ? 'starts ' + fmtDate(e.start)
      : 'from ' + fmtDate(e.start);
    return side + ' \u00b7 ' + state;
  }

  var historyId = null;

  function openHistory(e) {
    historyId = e.id;
    renderHistory();
    openPopup('popup-history');
  }

  function renderHistory() {
    var e = findById(historyId);
    if (!e) return;
    var threads = threadsFor(e);
    $('#proto-history-drug').textContent = e.drug + ' ' + e.sub;

    var pick = $('#proto-history-threads');
    pick.hidden = threads.length < 2;
    pick.innerHTML = threads.map(function (t) {
      return '<button type="button" class="proto-thread-btn' + (t.id === e.id ? ' is-on' : '')
        + '" data-act="thread" data-id="' + t.id + '">' + latIcon(t) + ' ' + esc(threadLabel(t)) + '</button>';
    }).join('');

    var src = e.sourceEntryId ? findById(e.sourceEntryId) : null;
    $('#proto-history-note').textContent = threads.length < 2
      ? ''
      : 'This drug has ' + threads.length + ' threads on the record. Each keeps its own history, '
        + 'because a change to one eye, or to a course that has since been stopped, is not a change to the others. '
        + 'You are looking at the ' + threadLabel(e).replace(/^\w/, function (c) { return c.toLowerCase(); }) + '.'
        + (src ? ' It continues the course that ran ' + fmtDate(src.start) + ' to ' + fmtDate(src.end) + '.' : '');

    $('#proto-history-body').innerHTML = e.history.slice().reverse().map(function (x) {
      return '<tr><td>' + fmtWhen(x.when) + '</td><td>' + esc(x.who) + '</td><td>' + esc(x.action) + '</td>'
        + '<td>' + esc(x.recordedAs) + '</td><td>' + esc(x.context) + '</td></tr>';
    }).join('');
  }

  /* ---- prescribing ---- */

  /* Generating an order. The form is chosen here, once, so the artefact cannot
     hold a mixture. Location is asked for here too, because it is a property of
     this fulfilment rather than of the patient's treatment. */
  var prescribing = null;

  /* The order is generated by the examination save, from the intention the
     element is holding. There is no confirmation dialog on the way, because the
     bar already says what is selected and which form it is going on, and
     nothing a dialog used to gather is a clinical direction: the dispensing
     instruction, the location and the note all sit on the order and stay
     editable until issue without disturbing the signature. The directions
     themselves freeze at signature.

     Called once, by the save. The record is committed by then, so what is
     snapshotted here is the saved record rather than a browser's idea of it. */
  function generateFromIntent(intent) {
    var all = selectedEntries();
    var included = all.filter(function (e) { return orderableForms(e).indexOf(intent.form) >= 0; });
    if (!included.length) return null;
    prescribing = { form: intent.form, entries: included };
    return createOrder(intent.mode === 'sign');
  }

  function defaultConditionFor(form) {
    var all = FORM_TYPES[form || 'hospital'].conditions;
    var conds = all.filter(function (c) { return inst().conditions.indexOf(c) >= 0; });
    if (!conds.length) conds = all;
    return conds.indexOf(inst().defaultCondition) >= 0 ? inst().defaultCondition : conds[0];
  }
  function orderCondition(e, form) { return defaultConditionFor(form); }

  function excludedFromForm(entries, form) {
    return entries.filter(function (e) { return orderableForms(e).indexOf(form) === -1; });
  }

  function createOrder(sign) {
    if (!prescribing) return;
    var form = prescribing.form;
    var f = FORM_TYPES[form];
    var all = selectedEntries();
    var cond = defaultConditionFor(form);
    var locs = {};
    prescribing.entries.forEach(function (e) {
      if (f.needsLocation) locs[e.id] = e.lastLocation || locationsFor(cond)[0];
    });

    var a = rx({
      id: 'RX-' + (++STATE.rxSeq),
      date: TODAY,
      /* Nobody is the prescriber of an unsigned draft. Whoever prepared it is
         named as the requester instead, and the prescriber arrives with the
         signature. */
      prescriber: sign ? user().name : null,
      formType: form,
      condition: cond,
      status: 'draft',
      entryIds: prescribing.entries.map(function (e) { return e.id; }),
      locations: locs,
      notes: '',
      signedAt: null, signedBy: null,
      issuedAt: null, issuedBy: null, issueTrigger: null,
      printedAt: null, printedBy: null
    });
    /* Signing snapshots the directions as attested. Saving as a draft snapshots
       them as requested, which is a different thing with a different weight:
       nobody may act on it, and the prescriber who signs later is shown it beside
       the record rather than in place of the record. */
    if (sign) signArtefact(a); else requestArtefact(a);
    /* An FP10 or PGD supply needs no hospital pharmacy signatures, which today is
       inferred from the condition names on the items. Here it is a property of the form. */
    if (!f.pharmacy) a.pharmacy = {};
    STATE.artefacts.push(a);

    prescribing.entries.forEach(function (e) {
      if (locs[e.id]) e.lastLocation = locs[e.id];
      e.history.push(h(nowStamp(), user().name, 'Ordered',
        directions(e) + ' on ' + a.id + ', ' + f.label.toLowerCase()
        + (locs[e.id] && locs[e.id] !== 'N/A' ? ', from ' + locs[e.id] : ''), a.id));
      STATE.selected.splice(STATE.selected.indexOf(e.id), 1);
    });

    prescribing = null;
    closePopups();
    render();
    switchView('artefacts');
    alertBox('success', '<strong>' + a.id + '</strong> generated by the save, as '
      + esc(formPhrase(form))
      + (sign ? ', signed by ' + esc(a.signedBy) : ', unsigned')
      + '. ' + (sign
          ? 'The directions are snapshotted as signed, so a later change to the record will not rewrite them: '
            + 'it flags the order instead. The dispensing instruction and the location are routing rather than '
            + 'direction, so they stay editable until it is issued, which happens when it is printed'
            + (f.pharmacy ? ' or when pharmacy starts signing.' : '.')
          : 'It holds what was asked for, and it is an instruction to nobody. Whoever signs it sees that request '
            + 'beside the record as it then stands, and their signature attests to the record rather than to the '
            + 'request.')
      + (excludedFromForm(all, form).length
          ? ' ' + esc(excludedFromForm(all, form).map(function (e) { return e.drug; }).join(', '))
            + ' cannot go on this form, so it stays selected for a separate order.'
          : ''));

    maybeAdviseGpContinues(a);
    return a;
  }

  /* One save, in one order: the record first, then the order generated from it.
     Printing is a real-world side effect that cannot be undone by cancelling a
     form, so nothing is generated until the record it rests on is committed.
     Because generation only happens here, an order for an abandoned
     examination is not a thing that can be reached. */
  $('#proto-commit-save').addEventListener('click', function () {
    var intent = rxIntent;
    var p = commitEvent();
    rxIntent = null;
    alertBox('success', '<strong>Examination saved.</strong> ' + p.length + ' medication change'
      + (p.length === 1 ? '' : 's') + ' written to the record, attributed to ' + esc(user().name)
      + '. The saved view of this examination will show the list as it stands now, with these rows marked, '
      + 'not whatever the list says next year.');
    if (intent) generateFromIntent(intent); else render();
  });

  /* Discard reverts the record to the last commit, which is what cancelling out of
     an examination does today for every other element. A signature or a request
     held on the element goes with it, and nothing was generated to undo. Issued
     orders are untouched: they are not children of the event and paper cannot
     be un-printed. */
  $('#proto-commit-discard').addEventListener('click', function () {
    var n = pendingChanges().length;
    var had = rxIntent;
    STATE.entries = JSON.parse(JSON.stringify(STATE.committed));
    STATE.selected = [];
    rxIntent = null;
    render();
    alertBox('', n + ' unsaved change' + (n === 1 ? '' : 's') + ' discarded'
      + (had ? ', and the ' + (had.mode === 'sign' ? 'signature' : 'requested prescription')
               + ' went with them: no prescription was ever generated' : '')
      + '. Any order already issued is unaffected, because it is not part of this event.');
  });

  /* ---- opening a prescription event ---- */

  function openRx(id, mode) {
    STATE.rxOpen = id || null;
    STATE.rxMode = id ? (mode || 'view') : 'view';
    rxeIntent = null;
    if (STATE.view !== 'artefacts') switchView('artefacts');
    render();
  }

  /* Edit mode is the answer to "how do I change this order". It is the same
     screen for a draft somebody else prepared and for an order this prescriber
     signed ten minutes ago and now wants to correct: the order at the top, the
     medication record underneath it, and the differences between them marked in
     both. Opening a signed order for editing takes the signature off, because a
     signature that survives an edit attests to nothing. */
  function openRxEdit(id) {
    var a = rxById(id);
    if (!a || !isOpen(a)) return;
    var u = user();
    var wasSigned = a.status === 'signed';
    if (wasSigned && !u.canPrescribe) {
      alertBox('', 'Only a prescriber can reopen a signed order. You can still change the medication record, '
        + 'and the order will be flagged as no longer matching it.');
      return;
    }
    if (wasSigned) dropSignature(a, 'Amended before issue');
    STATE.rxOpen = id;
    STATE.rxMode = 'edit';
    rxeIntent = null;
    /* The element's own selection belongs to the record screen. Inside an event
       the toggles mean something else, so nothing is carried in. */
    STATE.selected = [];
    if (STATE.view !== 'artefacts') switchView('artefacts');
    render();
    var diffs = draftDiffs(a).filter(function (d) { return d.kind === 'changed'; }).length;
    alertBox('', '<strong>' + esc(a.id) + '</strong> is open for editing, with the medication record inside it. '
      + (wasSigned
          ? 'The signature has come off and is kept in the order history with what it covered. Same order, same number. '
          : '')
      + (diffs
          ? '<strong>' + diffs + ' drug' + (diffs === 1 ? '' : 's') + ' differ' + (diffs === 1 ? 's' : '')
            + ' from what was ' + (draftBaseline(a) && draftBaseline(a).kind === 'requested' ? 'requested' : 'signed')
            + '.</strong> Each one is marked on the order and on the row below it. '
          : '')
      + 'Change the record below and it changes what this order will say. Nothing is written until you save.');
  }

  /* A drug going on or off the order from the element underneath it. This is the
     forgotten-drug case, and it stays one order with one number rather than
     becoming a second prescription for the same visit. */
  function rxSetItem(entryId, on) {
    var a = rxEditing();
    if (!a) return;
    var e = findById(entryId);
    if (!e) return;
    var at = a.entryIds.indexOf(entryId);
    if (on) {
      if (orderableForms(e).indexOf(a.formType) === -1) {
        render();
        alertBox('patient', esc(e.drug) + ' cannot go on ' + esc(formPhraseA(a.formType))
          + '. One order carries one form, so it needs an order of its own.');
        return;
      }
      if (at === -1) a.entryIds.push(entryId);
      var ft = FORM_TYPES[a.formType] || {};
      if (ft.needsLocation && !a.locations[entryId]) {
        a.locations[entryId] = e.lastLocation || locationsFor(a.condition)[0];
      }
    } else if (at >= 0) {
      a.entryIds.splice(at, 1);
    }
    render();
    alertBox('', esc(e.drug) + (on ? ' added to ' : ' taken off ') + esc(a.id)
      + '. The order now covers ' + artefactItems(a).length + ' drug'
      + (artefactItems(a).length === 1 ? '' : 's') + '.');
  }

  function rxToggleRequestIntent() {
    var a = rxEditing();
    if (!a) return;
    rxeIntent = (rxeIntent && rxeIntent.mode === 'request')
      ? null
      : { mode: 'request', rx: a.id, by: user().name, at: nowStamp(), fp: rxeFingerprint(a) };
    render();
  }

  /* One save for the event: the record change and the signature land together,
     exactly as they do on the examination. */
  $('#proto-rx-commit-save').addEventListener('click', function () {
    var a = rxEditing();
    if (!a) return;
    var intent = rxeIntent;
    var p = commitEvent();
    rxeIntent = null;
    var msg = '';
    if (p.length) {
      msg += '<strong>' + p.length + ' medication change' + (p.length === 1 ? '' : 's')
        + ' written to the record</strong>, attributed to ' + esc(user().name) + '. ';
    }
    if (intent && intent.mode === 'sign') {
      signArtefact(a);
      artefactItems(a).forEach(function (i) {
        var e = findById(i.entryId);
        if (e) e.history.push(h(nowStamp(), user().name, 'Ordered',
          directions(e) + ' on ' + a.id + ', ' + (FORM_TYPES[a.formType] || {}).label.toLowerCase(), a.id));
      });
      msg += '<strong>' + esc(a.id) + ' signed</strong> by ' + esc(a.signedBy)
        + '. It holds the record as this save left it, so a later change flags the order rather than rewriting it.';
    } else if (intent) {
      requestArtefact(a);
      msg += 'The request on <strong>' + esc(a.id) + '</strong> now says what the record says. It is still unsigned.';
    } else {
      msg += esc(a.id) + ' is unchanged as an order. It is still '
        + (isDraft(a) ? 'an unsigned request' : 'signed as it was') + '.';
    }
    STATE.rxMode = 'view';
    render();
    alertBox('success', msg);
  });

  $('#proto-rx-commit-discard').addEventListener('click', function () {
    var a = rxEditing();
    var n = pendingChanges().length;
    var had = rxeIntent;
    STATE.entries = JSON.parse(JSON.stringify(STATE.committed));
    rxeIntent = null;
    STATE.rxMode = 'view';
    render();
    alertBox('', n + ' unsaved change' + (n === 1 ? '' : 's') + ' discarded'
      + (had && had.mode === 'sign' ? ', and the signature went with them: nothing was signed' : '')
      + '. ' + (a ? esc(a.id) + ' is as it was.' : ''));
  });

  /* ---- issue ---- */

  /* First print is silent. Every print after that raises an advisory, because the
     system cannot tell a jammed printer from a copy that is already in circulation. */
  function rxPrint(id) {
    var a = rxById(id);
    if (a.printedAt) { openReprint(id); return; }
    doPrint(a);
    render();
    alertBox('success', '<strong>' + esc(a.id) + '</strong> printed, and therefore issued. The directions are now frozen and the order '
      + 'cannot be edited or deleted. If the print failed, reprint or reissue rather than editing.');
  }

  function doPrint(a) {
    a.printedAt = nowStamp();
    a.printedBy = user().name;
    a.printCount = (a.printCount || 0) + 1;
    if (isOpen(a)) issueArtefact(a, 'print');
  }

  var reprintId = null;

  function openReprint(id) {
    reprintId = id;
    var a = rxById(id);
    $('#proto-reprint-rx').textContent = a.id;
    $('#proto-reprint-count').textContent = a.printCount === 1
      ? 'It has been printed once already, ' + fmtWhen(a.printedAt) + '.'
      : 'It has been printed ' + a.printCount + ' times, most recently ' + fmtWhen(a.printedAt) + '.';
    openPopup('popup-reprint');
  }

  $('#proto-reprint-confirm').addEventListener('click', function () {
    var a = rxById(reprintId);
    doPrint(a);
    closePopups();
    render();
    alertBox('', esc(a.id) + ' reprinted (' + a.printCount + ' prints). It is the same order, not a new one. '
      + 'This is only safe because the earlier copy never reached the patient.');
  });

  $('#proto-reprint-reissue').addEventListener('click', function () {
    closePopups();
    openCancel(reprintId, true);
  });

  function rxSignRole(id, role) {
    var a = rxById(id);
    if (a.query && !a.query.resolvedAt && role !== 'Screened by') {
      alertBox('patient', 'There is an unresolved pharmacy query on ' + esc(a.id) + '. It cannot be completed until a prescriber resolves it.');
      return;
    }
    var justIssued = isOpen(a);
    if (justIssued) issueArtefact(a, 'dispensing');
    a.pharmacy[role] = { by: user().name, at: nowStamp() };
    if (!outstandingRoles(a).length && (!a.query || a.query.resolvedAt)) a.status = 'complete';
    render();
    var msg = esc(a.id) + ' signed as &ldquo;' + esc(role) + '&rdquo; by ' + esc(user().name) + '.';
    if (justIssued) msg += ' That first pharmacy signature also issued the order, so it is now frozen.';
    if (a.status === 'complete') msg += ' All roles have signed, so it leaves the pharmacy worklist.';
    alertBox('success', msg);
  }

  /* ---- cancel, reissue, query ---- */

  var cancelId = null, cancelThenReissue = false, queryId = null;

  function openCancel(id, thenReissue) {
    cancelId = id;
    cancelThenReissue = thenReissue;
    var a = rxById(id);
    $('#proto-cancel-rx').textContent = a.id;
    $('#proto-cancel-title').textContent = thenReissue ? 'Cancel and reissue' : 'Cancel prescription';
    var ft = FORM_TYPES[a.formType] || FORM_TYPES.hospital;
    var note = thenReissue
      ? 'The current order is cancelled and a replacement is created from the current medication record. Pharmacy sees both, linked.'
      : 'An issued order cannot be edited or deleted. Cancelling keeps it visible to pharmacy, marked as withdrawn.';
    /* Cancelling is only effective where the order came to us. Paper that has left
       the building cannot be recalled by a database field, and saying so is the
       difference between a prescriber who telephones the pharmacy and one who
       believes the system has handled it. */
    if (!ft.pharmacy) {
      note += ' This is an ' + ft.label + ', so the paper is with the patient and the dispensing pharmacy '
        + 'has no view of this record. Cancelling here records your decision. It does not recall the prescription, '
        + 'and you will need to contact the pharmacy directly if it matters.';
    }
    $('#proto-cancel-note').textContent = note;
    $('#proto-cancel-confirm').textContent = thenReissue ? 'Cancel and reissue' : 'Cancel prescription';
    openPopup('popup-cancel');
  }

  $('#proto-cancel-confirm').addEventListener('click', function () {
    var a = rxById(cancelId);
    var reason = $('#proto-cancel-reason').value;
    a.status = 'cancelled';
    a.cancelledAt = nowStamp();
    a.cancelledBy = user().name;
    a.cancelReason = reason;

    if (cancelThenReissue) {
      var live = a.entryIds.filter(function (id) {
        var e = findById(id);
        return e && e.status !== 'stopped';
      });
      var b = rx({
        id: 'RX-' + (++STATE.rxSeq),
        date: TODAY,
        prescriber: user().name,
        /* A correction stays on the same form as the order it replaces, and keeps
           its routing: the dispensing instruction and the locations were right
           for the original supply and nothing about a correction changes them. */
        formType: a.formType,
        condition: a.condition,
        locations: a.locations,
        status: 'draft',
        entryIds: live,
        signedAt: null, signedBy: null,
        issuedAt: null, issuedBy: null, issueTrigger: null,
        printedAt: null, printedBy: null,
        supersedesId: a.id,
        notes: 'Reissued from ' + a.id + ': ' + reason.toLowerCase() + '.'
      });
      a.supersededById = b.id;
      STATE.artefacts.push(b);
      closePopups();
      render();
      alertBox('success', esc(a.id) + ' cancelled (' + esc(reason) + ') and replaced by <strong>' + esc(b.id)
        + '</strong>, which picks up the current directions. The two are linked, so the audit reads as one event.');
      return;
    }
    closePopups();
    render();
    alertBox('', esc(a.id) + ' cancelled: ' + esc(reason) + '. It stays on the pharmacy worklist as cancelled rather than disappearing.');
  });

  function openQuery(id) {
    queryId = id;
    $('#proto-query-rx').textContent = rxById(id).id;
    $('#proto-query-text').value = '';
    openPopup('popup-query');
  }

  $('#proto-query-confirm').addEventListener('click', function () {
    var a = rxById(queryId);
    var text = $('#proto-query-text').value.trim() || 'Please confirm the dose.';
    a.query = { by: user().name, at: nowStamp(), text: text, resolvedAt: null, resolvedBy: null };
    closePopups();
    render();
    alertBox('', 'Query raised on ' + esc(a.id) + '. The prescriber is flagged and the order cannot complete until it is resolved. '
      + 'Today the only option would be to decline to sign, which tells the prescriber nothing.');
  });

  function rxResolve(id) {
    var a = rxById(id);
    a.query.resolvedAt = nowStamp();
    a.query.resolvedBy = user().name;
    if (!outstandingRoles(a).length) a.status = 'complete';
    render();
    alertBox('success', 'Query on ' + esc(a.id) + ' resolved by ' + esc(user().name)
      + '. If the directions themselves need to change, cancel and reissue instead.');
  }

  /* The OpenEyes collapse-data pattern: the header carries expand or collapse,
     and the body is shown by inline display rather than the hidden attribute. */
  document.addEventListener('click', function (ev) {
    var head = ev.target.closest && ev.target.closest('.js-collapse-data-header');
    if (!head) return;
    var body = head.parentElement.querySelector('.js-collapse-data-content');
    var open = head.classList.contains('collapse');
    head.classList.toggle('collapse', !open);
    head.classList.toggle('expand', open);
    head.setAttribute('aria-expanded', String(!open));
    body.style.display = open ? 'none' : 'block';
  });

  /* Allergies sit in the element footer beside the adders, as IDG shows them,
     because they are a property of the patient that this element has to respect
     rather than a row-level warning. */
  function renderAllergies() {
    var names = CATALOGUE.filter(function (c) { return c.allergy; })
      .map(function (c) { return c.drug; });
    $('#proto-allergy-list').innerHTML = ['Pollen'].concat(names)
      .map(function (n) { return '<span class="proto-allergy">' + esc(n) + '</span>'; }).join('');
  }

  /* ----------------------------------------------------------------- start */

  seed();
  renderAllergies();
  STATE.committed = cloneEntries();
  switchView('record');
  render();
})();
