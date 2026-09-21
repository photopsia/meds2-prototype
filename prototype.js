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
    draft:     { label: 'Draft',     note: 'Unsigned. Directions are read live from the medication record and can still change.' },
    signed:    { label: 'Signed',    note: 'Signed. These directions were snapshotted at signature and no longer follow the record. Amend by voiding the signature and re-signing.' },
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
    '':          '\u2013',
    hospital:    'Hospital',
    hospital_gp: 'Hospital, then GP',
    gp:          'GP',
    patient:     'Patient'
  };
  var RESP_ORDER = ['', 'hospital', 'hospital_gp', 'gp', 'patient'];

  /* The default, used when nothing has been set explicitly. A drug with no end
     date is going to outlive this episode, so the GP is who we are relying on. A
     fixed course ends, so there is nothing for anyone to continue and we are
     supplying it. Same null-means-derived pattern as eye relevance: the row shows
     the derived value in muted text, an explicit choice in normal text, and only
     explicit choices go in the change history. */
  function defaultSupply(e) {
    return e.end ? 'hospital' : 'gp';
  }

  function effectiveSupply(e) {
    return (e.supply === null || e.supply === undefined) ? defaultSupply(e) : e.supply;
  }

  /* The existing dispense conditions, with the locations each one allows, exactly
     as the real lookups hold them. These live on the ORDER, not on the medication.
     The flags are the ones section 7a proposes: stated on the condition instead of
     inferred from its name. `supplyAfterIssue` is how an order writes back to the
     record: issuing "Hospital to supply and GP to continue" sets the row to
     Hospital, then GP. Note that it does not set GP. We have just supplied the
     drug, so saying the GP is responsible today would be untrue, and the value
     would then have to change again later with nobody driving it. */
  var DISPENSE_CONDITIONS = [
    { id: 'hospital', name: 'Hospital to supply',                    locations: ['Pharmacy', 'TTO Pre-Pack', 'Ward Fridge'],
                      prescribes: true, form: 'hospital', needsLocation: true, pharmacy: true, supplyAfterIssue: 'hospital' },
    { id: 'hospgp',   name: 'Hospital to supply and GP to continue', locations: ['Pharmacy', 'TTO Pre-Pack', 'Ward Fridge'],
                      prescribes: true, form: 'hospital', needsLocation: true, pharmacy: true, supplyAfterIssue: 'hospital_gp' },
    { id: 'fp10',     name: 'Print to FP10',                         locations: ['N/A'],
                      prescribes: true, form: 'fp10', overprint: true, supplyAfterIssue: null },
    { id: 'pgd',      name: 'Supply under PGD',                      locations: ['Ward Fridge', 'Pharmacy'],
                      pgd: true, form: 'pgd', needsLocation: true, supplyAfterIssue: 'hospital' }
  ];

  /* One artefact, one form type. The form is chosen when the order is generated,
     not per drug, so a prescription can never hold a mixture that only half of
     it can be printed on. */
  var FORM_TYPES = {
    hospital: { label: 'Hospital prescription', conditions: ['hospital', 'hospgp'], needsLocation: true, pharmacy: true },
    fp10:     { label: 'FP10',                  conditions: ['fp10'],               needsLocation: false, pharmacy: false },
    pgd:      { label: 'Supply under PGD',      conditions: ['pgd'],                needsLocation: true, pharmacy: false }
  };
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
    nextAppointment: d(21),
    user: 'prescriber',
    seq: 20,
    rxSeq: 1041,
    entries: [],
    artefacts: [],
    /* Transient. Which rows are toggled on for the next order. Never persisted,
       because a stored "to be prescribed" flag is a second source of truth about
       intent and is exactly what gets left set and produces next month's duplicate. */
    selected: [],
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
           start: d(-191),
           history: [
             h(ts(-191, '09:14'), 'Mr A Prescriber', 'Started', '1 drop, At night, Eye, Right', 'Glaucoma clinic')
           ] }),
      mk({ drug: 'Dorzolamide / Timolol', sub: '2% / 0.5% eye drops (Cosopt)', indication: 'D1', group: 'eye',
           dose: '1', unit: 'drop', freq: 'Twice daily', route: 'Eye', lat: 'Both',
           start: d(-107),
           history: [
             h(ts(-107, '11:02'), 'Mr A Prescriber', 'Started', '1 drop, Twice daily, Eye, Both', 'Glaucoma clinic'),
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
      /* The compound condition case. Ongoing, so it defaults to GP. Order it on
         "Hospital to supply and GP to continue" and the row becomes Hospital, then
         GP: we have supplied this course, the GP picks it up after. */
      mk({ drug: 'Acetazolamide', sub: '250mg tablets', indication: 'D1', group: 'systemic-ophth',
           dose: '250', unit: 'mg', freq: 'Twice daily', route: 'Oral', lat: '',
           start: TODAY,
           history: [
             h(TODAY + ' 14:24', 'Mr A Prescriber', 'Started', '250mg, Twice daily, Oral', 'Uveitis clinic')
           ] }),
      /* Ongoing, so the default would be GP, but a reducing course of oral
         steroid for uveitis is ours to supply. An explicit value overriding the
         default, which is why the row reads it in normal rather than muted text. */
      mk({ drug: 'Prednisolone', sub: '5mg tablets', indication: 'D2', group: 'systemic-ophth',
           dose: '30', unit: 'mg', freq: 'Once daily', route: 'Oral', lat: '',
           start: d(-35), supply: 'hospital',
           history: [
             h(ts(-35, '10:40'), 'Mr A Prescriber', 'Started', '40mg, Once daily, Oral', 'Uveitis clinic'),
             h(ts(-14, '10:15'), 'Mr A Prescriber', 'Changed', '30mg, Once daily, Oral', 'Uveitis clinic')
           ] }),
      mk({ drug: 'Hydroxychloroquine', sub: '200mg tablets', indication: 'D4', group: 'systemic-other',
           dose: '200', unit: 'mg', freq: 'Once daily', route: 'Oral', lat: '',
           start: d(-1479), supply: 'gp', source: 'GP record',
           history: [ h(ts(-1479, '00:00'), 'GP record import', 'Recorded', '200mg, Once daily, Oral', 'Primary care') ] }),
      mk({ drug: 'Amlodipine', sub: '5mg tablets', indication: 'D5', group: 'systemic-other',
           dose: '5', unit: 'mg', freq: 'Once daily', route: 'Oral', lat: '',
           start: d(-983), supply: 'gp', source: 'GP record',
           history: [ h(ts(-983, '00:00'), 'GP record import', 'Recorded', '5mg, Once daily, Oral', 'Primary care') ] }),
      mk({ drug: 'Metformin', sub: '500mg tablets', indication: 'D6', group: 'systemic-other',
           dose: '500', unit: 'mg', freq: 'Twice daily', route: 'Oral', lat: '',
           start: d(-1236), supply: 'gp', source: 'GP record',
           history: [ h(ts(-1236, '00:00'), 'GP record import', 'Recorded', '500mg, Twice daily, Oral', 'Primary care') ] }),
      /* The reason "Patient" has to exist as a value. This is bought over the
         counter, so it will never appear in the GP record, and without somewhere
         to say so reconciliation would report it as missing at every comparison,
         forever. */
      mk({ drug: 'Hypromellose', sub: '0.3% eye drops', group: 'eye',
           dose: '1', unit: 'drop', freq: 'As required', route: 'Eye', lat: 'Both',
           start: d(-519), supply: 'patient', source: 'Patient reported',
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
      signatures: [{ by: 'Mr A Prescriber', at: ts(-107, '11:05'), voidedAt: null, voidedBy: null, reason: null }],
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
    o.indication = o.indication || null;
    o.advice = o.advice || null;
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
  function directions(e) {
    var bits = [e.dose + (e.unit === 'drop' ? ' drop' + (e.dose === '1' ? '' : 's') : e.unit), e.freq, e.route];
    if (e.lat) bits.push(e.lat);
    return bits.join(', ');
  }

  /* Responsibility is offered to everyone and is not gated by institution or by
     prescribing rights, because recording that the GP is responsible for a drug
     is an observation about this patient's care, not an act of prescribing. A
     nurse or an optometrist can state it as well as a consultant can. */
  function supplyOptions() { return RESP_ORDER.slice(); }

  /* May this user generate an order for this drug, on any form? The toggle appears
     only if the answer is yes, for the same reason an unavailable supply option is
     absent rather than greyed out. */
  function canOrder(e) {
    if (e.status === 'stopped') return false;
    return orderableForms(e).length > 0;
  }
  /* Which form types this user could put this drug on, right now. Note that the
     row's supply responsibility plays no part: a drug the GP normally supplies is
     still orderable today, because ordering is a decision made now, not a property
     of the medication. */
  function orderableForms(e) {
    var u = user();
    var i = inst();
    var out = [];
    Object.keys(FORM_TYPES).forEach(function (f) {
      var usable = FORM_TYPES[f].conditions.filter(function (cid) {
        var c = condById(cid);
        if (i.conditions.indexOf(cid) === -1) return false;
        if (c.overprint && !i.overprint) return false;
        if (c.prescribes && !u.canPrescribe) return false;
        if (c.pgd && !pgdForDrug(e.drug)) return false;
        return true;
      });
      if (usable.length) out.push(f);
    });
    return out;
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
    return e.group === 'eye' || e.group === 'systemic-ophth';
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

  function nextAppt() { return STATE.nextAppointment || ''; }

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
  function adviceDate(a) {
    if (a.anchor === 'date') return a.date || null;
    if (!nextAppt()) return null;
    return a.anchor === 'at-appt' ? nextAppt() : addDays(nextAppt(), -Math.abs(a.days || 0));
  }

  function adviceWording(a) {
    var verb = a.action === 'stop' ? 'Stop' : 'Hold';
    var when = adviceDate(a);
    if (a.anchor === 'date') return verb + ' on ' + fmtDate(a.date);
    if (a.anchor === 'at-appt') {
      return when ? verb + ' at the appointment on ' + fmtDate(when) : verb + ' at the next appointment, date not yet booked';
    }
    var rel = verb + ' ' + a.days + ' days before the next appointment';
    return when ? rel + ', which is ' + fmtDate(when) : rel + ', date not yet booked';
  }

  function awaiting() {
    return STATE.entries.filter(function (e) { return e.advice && e.advice.status === 'awaiting'; });
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

  /* The directions an artefact carries. While it is an unsigned draft it holds no
     copy of its own: it is a projection of the current record, so editing the
     record edits it. At signature the directions are snapshotted into `frozen`
     and stop tracking, because a signature has to attest to specific content. */
  function artefactItems(a) {
    if (a.frozen) return a.frozen;
    return a.entryIds.map(function (id) {
      var e = findById(id);
      if (!e) return null;
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
    a.divergedAt = null;
    a.divergedBy = null;
    a.signatures = a.signatures || [];
    a.signatures.push({ by: a.signedBy, at: a.signedAt, voidedAt: null, voidedBy: null, reason: null });
  }

  /* Amending a signed order. The order keeps its number: this is deliberately
     cheaper than cancelling and far cheaper than a second prescription, which is
     what makes freezing at signature affordable. The old signature is kept rather
     than overwritten, so the sequence stays auditable. */
  function voidSignature(a, reason) {
    var last = (a.signatures || [])[a.signatures.length - 1];
    if (last && !last.voidedAt) {
      last.voidedAt = nowStamp();
      last.voidedBy = user().name;
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
    transferSupply(a);
    /* Issue is a committed act, so the responsibility it moves is committed with
       it rather than sitting as an unsaved change nobody made. */
    commitEvent();
  }

  /* On issue, the condition used on the order says what becomes true about who
     supplies the drug from now on. That is the whole of the compound condition
     problem: "Hospital to supply and GP to continue" is an instruction for today
     and a statement about tomorrow, and only the second belongs on the record. */
  function transferSupply(a) {
    a.entryIds.forEach(function (id) {
      var e = findById(id);
      if (!e) return;
      var c = condById(a.condition || orderCondition(e, a.formType));
      if (!c || !c.supplyAfterIssue || c.supplyAfterIssue === effectiveSupply(e)) return;
      var was = RESPONSIBILITY[effectiveSupply(e)];
      e.supply = c.supplyAfterIssue;
      e.history.push(h(nowStamp(), 'System', 'Responsibility to supply moved',
        was + ' to ' + RESPONSIBILITY[e.supply] + ', on issue of ' + a.id + ' (' + c.name + ')', a.id));
    });
  }

  /* ------------------------------------------------------------- rendering */

  /* Two different markers. "Not yet saved" is about the commit boundary and
     clears on save. "Changed at this visit" is durable and is what the saved
     view shows. Conflating them would hide the one that matters. */
  function renderCommitBar() {
    var p = pendingChanges();
    var bar = $('#proto-commit-bar');
    bar.hidden = !p.length;
    if (!p.length) return;
    var counts = { added: 0, changed: 0, stopped: 0 };
    p.forEach(function (x) { counts[x.kind]++; });
    var parts = [];
    if (counts.added) parts.push(counts.added + ' added');
    if (counts.changed) parts.push(counts.changed + ' changed');
    if (counts.stopped) parts.push(counts.stopped + ' stopped');
    $('#proto-commit-text').innerHTML = '<strong>' + p.length + ' change'
      + (p.length === 1 ? '' : 's') + ' not yet saved</strong> (' + parts.join(', ')
      + '). Nothing here is in the record, or visible to anyone else, until the examination is saved.';
  }

  function render() {
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
  function renderReconcile() {
    var due = awaiting();
    var box = $('#proto-reconcile');
    if (!due.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="alert-box patient proto-reconcile">'
      + '<strong>Planned changes awaiting confirmation.</strong> '
      + 'These were planned at an earlier visit. Nobody has recorded whether they happened, so the record still '
      + 'shows them as being taken.'
      + '<ul class="proto-reconcile-list">'
      + due.map(function (e) {
          return '<li><span class="proto-strong">' + esc(e.drug) + '</span> &mdash; ' + esc(adviceWording(e.advice))
            + '. Planned by ' + esc(e.advice.by) + ' on ' + esc(fmtWhen(e.advice.at))
            + ' <button type="button" class="proto-btn-confirm" data-act="confirm" data-id="' + e.id + '">Confirm</button></li>';
        }).join('')
      + '</ul></div>';
  }

  function renderGroup(group) {
    var tbody = $('#tbody-' + group);
    var rows = STATE.entries.filter(function (e) { return displayGroup(e) === group && e.status !== 'stopped'; });
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
      tags += '<i class="oe-i clock small pad-r no-click" title="Starts ' + esc(fmtDate(e.start)) + '"></i>';
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

    /* Responsibility to supply, read as a label and changed in the Change dialog.
       Not a dispense condition: that belongs to the order and is chosen when the
       order is generated. Muted text means nobody has set it and the row is
       showing the default for its duration. */
    var supplyIsSet = !(e.supply === null || e.supply === undefined);
    var sel = '<span class="proto-supply-value' + (supplyIsSet ? '' : ' is-derived')
      + '" title="' + (supplyIsSet ? 'Set on this record' : 'Default for a drug with no stop date; change it on the Change dialog') + '">'
      + esc(RESPONSIBILITY[effectiveSupply(e)]) + '</span>';

    var supplyNote = '';
    if (rxa && isIssued(rxa)) supplyNote = 'On issued order ' + rxa.id;
    else if (rxa) supplyNote = 'On ' + rxa.id + ', not yet issued';
    else if (e.source) supplyNote = 'Source: ' + e.source;

    /* The toggle is a selection, never a stored field. It appears only where this
       user could actually generate something for this drug. */
    var toggle = '';
    if (canOrder(e)) {
      toggle = '<label class="proto-toggle" title="Include in the next order">'
        + '<input type="checkbox" data-act="rxsel" data-id="' + e.id + '"'
        + (STATE.selected.indexOf(e.id) >= 0 ? ' checked' : '') + '>'
        + '<span class="proto-toggle-track"><span class="proto-toggle-knob"></span></span></label>';
    }

    var dx = e.indication ? dxById(e.indication) : null;

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
            ? '<button type="button" class="proto-btn-confirm" data-act="confirm" data-id="' + e.id + '">Confirm</button> '
            : '')
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

     The form is a radio rather than one button per form, because signing is one
     act: pick the form, enter the PIN, the order exists. */
  function renderPrescribeBar() {
    var sel = selectedEntries();
    var bars = $$('.proto-rx-bar');

    if (!sel.length || STATE.view !== 'record') {
      bars.forEach(function (b) { b.hidden = true; });
      return;
    }

    var forms = {};
    sel.forEach(function (e) { orderableForms(e).forEach(function (f) { forms[f] = (forms[f] || 0) + 1; }); });
    var names = Object.keys(FORM_TYPES).filter(function (f) { return forms[f]; });
    if (rxForm && names.indexOf(rxForm) === -1) rxForm = null;
    if (!rxForm) rxForm = names[0] || null;

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
      bar.querySelector('.proto-draft-cb').checked = rxDraft;
      bar.querySelector('.proto-rx-pin').value = '';
      bar.querySelector('.proto-rx-pin').hidden = rxDraft;
      bar.querySelector('.proto-pin-wrap').classList.toggle('is-draft', rxDraft);
      bar.querySelector('.proto-pin-label').textContent = rxDraft ? 'Create draft order' : 'Sign by PIN';
    });
  }

  var rxForm = null;
  var rxDraft = false;

  document.addEventListener('change', function (ev) {
    if (ev.target.dataset && ev.target.dataset.rxForm) { rxForm = ev.target.value; renderPrescribeBar(); return; }
    if (ev.target.classList && ev.target.classList.contains('proto-draft-cb')) {
      rxDraft = ev.target.checked;
      renderPrescribeBar();
      return;
    }
  });

  /* Six digits and it signs, which is how every other PIN field in OpenEyes
     behaves. A draft needs no PIN, so the draft path has its own button. */
  document.addEventListener('input', function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains('proto-rx-pin')) return;
    if (ev.target.value.length >= 6 && rxForm) {
      ev.target.value = '';
      prescribeFromBar(rxForm, true);
    }
  });

  function renderArtefacts() {
    var wrap = $('#proto-artefact-list');
    if (!STATE.artefacts.length) {
      wrap.innerHTML = '<div class="proto-empty">No prescriptions issued.</div>';
      return;
    }
    wrap.innerHTML = STATE.artefacts.slice().reverse().map(artefactHtml).join('');
  }

  function artefactHtml(a) {
    var items = artefactItems(a);
    var diverged = divergedItems(a);
    var frozen = !!a.frozen;

    var ft = FORM_TYPES[a.formType] || FORM_TYPES.hospital;

    var meta = [];
    meta.push('Form: ' + esc(ft.label));
    meta.push('Prescriber: ' + esc(a.prescriber));
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

    var rows = items.map(function (i) {
      var s = i.snapshot;
      var dirs = [s.dose + (s.unit === 'drop' ? ' drop' + (s.dose === '1' ? '' : 's') : s.unit), s.freq, s.route];
      if (s.lat) dirs.push(s.lat);
      var changed = diverged.indexOf(i) >= 0;
      return '<tr' + (changed ? ' class="proto-diverged-row"' : '') + '>'
        + '<td>' + esc(i.drug) + '<span class="proto-drug-sub">' + esc(i.sub) + '</span></td>'
        + '<td>' + esc(dirs.join(', '))
        +   (s.taper && s.taper.length ? '<span class="proto-drug-sub">then ' + s.taper.map(function (t) { return esc(t.freq) + ' from ' + fmtDate(t.from); }).join(', ') + '</span>' : '')
        +   (changed ? '<span class="proto-drug-sub">record now says: ' + esc(directions(findById(i.entryId))) + '</span>' : '')
        + '</td>'
        + '<td>' + (ft.needsLocation && !frozen
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
    var condCtl = frozen || !isOpen(a)
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
    if (u.canPrescribe && isDraft(a)) {
      actions.push(btn('rx-sign', a.id, 'Sign', true));
    }
    if (u.canPrescribe && a.status === 'signed') {
      actions.push(btn('rx-print', a.id, 'Print and issue', true));
      actions.push(btn('rx-void', a.id, 'Void signature and amend'));
    }
    if (u.canPrescribe && isIssued(a)) {
      actions.push(btn('rx-print', a.id, 'Reprint'));
      actions.push(btn('rx-cancel', a.id, 'Cancel'));
      actions.push(btn('rx-reissue', a.id, 'Cancel and reissue'));
    }
    if (u.canPrescribe && a.status === 'cancelled' && !a.supersededById) {
      actions.push(btn('rx-reissue', a.id, 'Reissue from current record'));
    }
    if (u.canPrescribe && a.query && !a.query.resolvedAt) {
      actions.push(btn('rx-resolve', a.id, 'Resolve query', true));
    }
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
      notes += '<div class="proto-frozen-note proto-projection">Unsigned draft. It holds no directions of its own: '
        + 'these are read from the medication record, so a change there changes this order. '
        + 'The directions are snapshotted the moment somebody signs.</div>';
    } else if (diverged.length) {
      notes += '<div class="proto-frozen-note proto-diverged">'
        + '<strong>The medication record has changed since this was signed</strong>'
        + (a.divergedAt ? ', ' + fmtWhen(a.divergedAt) + ' by ' + esc(a.divergedBy) : '') + '.<br>'
        + diverged.map(function (i) {
            var e = findById(i.entryId);
            var s = i.snapshot;
            return esc(i.drug) + ': signed as <strong>' + esc([s.dose + (s.unit === 'drop' ? ' drop' + (s.dose === '1' ? '' : 's') : s.unit), s.freq].join(', '))
              + '</strong>, record now says <strong>' + esc(directions(e)) + '</strong>';
          }).join('<br>')
        + '<br>' + (isIssued(a)
            ? 'This order has been issued, so it cannot be changed. Cancel and reissue if the patient needs supply at the current directions.'
            : 'This order still says what was signed. Void the signature and sign again to make it match, cancel it, or leave it if the signed directions are still what should be dispensed.')
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
      +   '<table class="standard proto-sign-table"><thead><tr><th>Drug</th>'
      +     '<th>' + (frozen ? 'Directions as signed' : 'Directions (live from the record)') + '</th><th>Dispense location</th></tr></thead>'
      +     '<tbody>' + rows + '</tbody></table>'
      +   '<div class="proto-worklist-line"><span class="proto-worklist-label">Pharmacy worklist</span> ' + chips
      +     '<span class="proto-worklist-state">' + worklistState(a) + '</span></div>'
      +   notes
      +   (actions.length ? '<div class="flex-layout flex-right" style="margin-top:10px">' + actions.join(' ') + '</div>' : '')
      + '</div></div></section>';
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

    var t = ev.target.closest('[data-act], .proto-tab, .proto-add, .proto-set-add, .proto-close, .proto-result, .proto-pin-label');
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

    if (t.classList.contains('proto-pin-label') && rxDraft && rxForm) {
      ev.preventDefault();
      prescribeFromBar(rxForm, false);
      return;
    }

    var act = t.dataset.act;
    var e = t.dataset.id ? findById(t.dataset.id) : null;

    switch (act) {
      case 'edit':     openEdit(e); break;
      case 'stop':     openAction(e, 'stop'); break;
      case 'history':  openHistory(e); break;
      case 'hold':     if (e.status === 'held') { toggleHold(e); } else { openAction(e, 'hold'); } break;
      case 'relevance': toggleRelevance(e); break;
      case 'confirm':  openConfirm(e); break;
      case 'restart':  restart(e); break;
      case 'rx-sign':      openSign(t.dataset.rx); break;
      case 'rx-void':      rxVoid(t.dataset.rx); break;
      case 'rx-print':     rxPrint(t.dataset.rx); break;
      case 'rx-role':      rxSignRole(t.dataset.rx, t.dataset.role); break;
      case 'rx-cancel':    openCancel(t.dataset.rx, false); break;
      case 'rx-reissue':   openCancel(t.dataset.rx, true); break;
      case 'rx-query':     openQuery(t.dataset.rx); break;
      case 'rx-resolve':   rxResolve(t.dataset.rx); break;
      case 'prescribe':    prescribeFromBar(t.dataset.form, true); break;
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
    }
  });

  /* ---- views ---- */

  var GUIDE = {
    record: 'Try adding a drug the patient is already on, setting a duration and a reducing course from the Change dialog, or changing a dose that is already on an issued prescription. Watch the unsaved-changes bar: nothing is in the record until the examination is saved. Switch role in the top right to see prescribing rights change.',
    artefacts: 'A prescription is editable until it is issued, and frozen from then on. Issue means printed, or pharmacy has started signing. Create one, change a dose on the record and watch it follow; then print it and try the same change. Switch to the Pharmacist role to sign the dispensing roles or raise a query.',
    model: 'This tab is a reading aid, not part of the proposed interface.'
  };

  function switchView(v) {
    $$('.proto-view').forEach(function (el) { el.hidden = el.id !== 'view-' + v; });
    $$('.proto-tab').forEach(function (el) { el.classList.toggle('selected', el.dataset.view === v); });
    $('#proto-guide-text').textContent = GUIDE[v];
    STATE.view = v;
    renderPrescribeBar();
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

  var addPick = null;

  function openAdd() {
    addPick = null;
    $('#proto-search').value = '';
    $('#proto-add-brands').checked = false;
    $('#proto-add-pf').checked = false;
    renderAdderColumn('proto-add-common-eye', COMMON_EYE);
    renderAdderColumn('proto-add-common-sys', COMMON_SYSTEMIC);
    renderSearch('');
    renderAddNote();
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
    return '<label' + (block ? ' class="is-on-record" title="Already on the record"' : '') + '>'
      + '<input type="radio" name="proto-add-pick" value="' + idx + '">'
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
    if (!addPick) { box.innerHTML = ''; return; }
    var c = CATALOGUE[addPick];
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
      addPick = parseInt(ev.target.value, 10);
      $('#proto-add-next').disabled = false;
      renderAddNote();
    }
  });

  $('#proto-add-next').addEventListener('click', function () {
    if (addPick == null) return;
    pickDrug(addPick);
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

    if (top === 1) {
      $('#proto-dup-explain').textContent = 'The record holds at most one active entry per drug per patient. '
        + 'Rather than creating a second line, change the existing one. Its full history is preserved.';
      $('#proto-dup-anyway').hidden = true;
      $('#proto-dup-edit').textContent = 'Change the existing entry';
    } else if (top === 2) {
      $('#proto-dup-explain').textContent = 'This is not an exact duplicate, so it is not blocked, but the patient '
        + 'would be taking the same substance twice. That is occasionally deliberate and usually not. '
        + 'The system asks rather than decides.';
      $('#proto-dup-anyway').hidden = false;
      $('#proto-dup-edit').textContent = 'Change the existing entry instead';
    } else {
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

  function pickDrug(idx) {
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
      openConflict(c, conflicts, function () { addFromCatalogue(c, true); });
      return;
    }
    addFromCatalogue(c, false);
  }

  function addFromCatalogue(c, overridden) {
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
      start: TODAY, supply: null,
      history: [ h(nowStamp(), user().name, 'Started',
        overridden ? 'Added to medication record, conflict acknowledged' : 'Added to medication record',
        'Medication record') ]
    });
    STATE.entries.push(e);
    STATE.lastChanged = e.id;
    closePopups();
    render();
    alertBox('success', '<strong>' + esc(c.drug) + '</strong> added. Set the route, dose and frequency, say how long '
      + 'it is for, and tick Dispense if it needs an order. Nothing here commits until the examination is saved.'
      + (overridden ? ' The conflict you acknowledged is recorded in this drug\u2019s history.' : ''));
    openEdit(e);
  }

  $('#proto-dup-edit').addEventListener('click', function () {
    closePopups();
    openEdit(findById(this.dataset.id));
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
        + 'To make the order match, void the signature on the Prescriptions tab and sign again.';
    } else if (a) {
      note.hidden = false;
      note.innerHTML = 'This medication is on <strong>' + esc(a.id) + '</strong>, an unsigned draft. '
        + 'A draft holds no directions of its own, so it will simply pick this change up.';
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
        + ' days before the next appointment. The date is worked out when the appointment is known, '
        + 'and the drug stays on the record until someone confirms it was stopped.';
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
        wantLat + ', the operated eye', 'Medication record'));
    }
    sideFromHost = false;
    e.start = $('#proto-edit-start').value;
    e.status = e.start > TODAY ? 'planned' : (e.status === 'held' ? 'held' : 'current');

    var newSupply = btnVal('proto-edit-supply');
    if (newSupply !== effectiveSupply(e)) {
      e.history.push(h(nowStamp(), user().name, 'Responsibility to supply changed',
        RESPONSIBILITY[effectiveSupply(e)] + ' to '
        + (newSupply ? RESPONSIBILITY[newSupply] : 'not stated'), 'Medication record'));
      e.supply = newSupply;
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
      e.history.push(h(nowStamp(), user().name, 'Course set', courseSummary(e), 'Medication record'));
    }

    // Indication is metadata, not directions, so it is recorded separately and
    // never voids a signature. It can move the drug between groups.
    if (e.pendingIndication !== e.indication) {
      var wasRelevant = isEyeRelevant(e);
      e.indication = e.pendingIndication;
      var dx = e.indication ? dxById(e.indication) : null;
      e.history.push(h(nowStamp(), user().name, 'Indication recorded',
        dx ? dx.name : 'Cleared', 'Medication record'));
      if (isEyeRelevant(e) !== wasRelevant && !isOverridden(e)) {
        e.history.push(h(nowStamp(), user().name,
          isEyeRelevant(e) ? 'Became eye relevant' : 'No longer eye relevant',
          'Follows from the indication', 'Medication record'));
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
      e.history.push(h(nowStamp(), user().name, 'Changed', after, 'Medication record'));
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
          + 'To make the order match, void the signature and sign again.';
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
      e.history.push(h(nowStamp(), user().name, 'Resumed', directions(e), 'Medication record'));
    } else {
      e.status = 'held';
      e.history.push(h(nowStamp(), user().name, 'Held', 'Temporarily suspended, not stopped', 'Medication record'));
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
          'Medication record') ]
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
        directions(e) + ' (from ' + before + ', taken from ' + src.name + ')', 'Medication record'));
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

  /* The preview is the point of this dialog: the clinician sees exactly what the
     patient and the letter will say, including the case where no date can be given. */
  function syncAdvise() {
    var a = currentAdvice();
    var now = a.anchor === 'now';
    $('#proto-advise-days-wrap').hidden = a.anchor !== 'before-appt';
    $('#proto-advise-date-wrap').hidden = a.anchor !== 'date';
    $('#proto-advise-text-wrap').hidden = now;
    $('#proto-advise-title').textContent = (a.action === 'stop' ? 'Stop' : 'Hold') + ' medication';
    var e = findById(advisingId);

    if (now) {
      $('#proto-advise-preview').innerHTML = 'This takes effect <strong>immediately</strong>. '
        + esc(e.drug) + ' will show as ' + (a.action === 'stop' ? 'stopped' : 'on hold') + ' from today.';
      return;
    }

    var resolved = adviceDate(a);
    var msg = '<strong>' + esc(adviceWording(a)) + '.</strong> ';
    msg += resolved
      ? 'The letter and the patient instruction will carry this date, and it will be recalculated if the appointment moves.'
      : 'No date can be given yet, so the letter and the patient instruction will use the relative wording and the date will appear once the appointment is booked.';
    msg += ' ' + esc(e.drug) + ' stays on the record as being taken until someone confirms what happened.';
    $('#proto-advise-preview').innerHTML = msg;
    // Keep the suggested wording in step with the anchor until the clinician edits it.
    if (!adviceTextTouched) {
      var whenWords = a.anchor === 'at-appt' ? 'at your next appointment'
        : a.anchor === 'date' ? (a.date ? 'on ' + fmtDate(a.date) : 'on the date given')
        : a.days + ' days before your next appointment';
      $('#proto-advise-text').value = (a.action === 'stop' ? 'Stop taking ' : 'Pause ')
        + e.drug.toLowerCase() + ' ' + whenWords + '.';
    }
  }

  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'proto-advise-text') adviceTextTouched = true;
  });

  ['proto-advise-action', 'proto-advise-anchor', 'proto-advise-days', 'proto-advise-date'].forEach(function (id) {
    document.addEventListener('change', function (ev) { if (ev.target.id === id) syncAdvise(); });
    document.addEventListener('input', function (ev) { if (ev.target.id === id) syncAdvise(); });
  });

  $('#proto-advise-save').addEventListener('click', function () {
    var e = findById(advisingId);
    var a = currentAdvice();

    if (a.anchor === 'now') {
      var reason = $('#proto-advise-reason').value;
      if (a.action === 'stop') {
        e.status = 'stopped';
        e.end = TODAY;
        e.stopReason = reason || 'Stopped';
        e.supply = '';
        e.history.push(h(nowStamp(), user().name, 'Stopped', e.stopReason, 'Medication record'));
      } else {
        e.status = 'held';
        e.history.push(h(nowStamp(), user().name, 'Held',
          reason || 'Temporarily suspended, not stopped', 'Medication record'));
      }
      STATE.lastChanged = e.id;
      closePopups();
      render();
      alertBox('', '<strong>' + esc(e.drug) + '</strong> '
        + (a.action === 'stop' ? 'stopped.' : 'put on hold.')
        + (a.action === 'stop' ? ' Any prescription already issued for it remains on the record as an artefact.' : ''));
      return;
    }

    a.text = $('#proto-advise-text').value;
    a.reason = $('#proto-advise-reason').value;
    a.by = user().name;
    a.at = nowStamp();
    a.status = 'awaiting';
    a.outcomeNote = '';
    e.advice = a;
    e.history.push(h(a.at, a.by, a.action === 'stop' ? 'Stop planned' : 'Hold planned',
      adviceWording(a) + '. Not yet actioned', 'Medication record'));
    STATE.lastChanged = e.id;
    closePopups();
    render();
    alertBox('', '<strong>' + esc(e.drug) + '</strong> is planned to ' + (a.action === 'stop' ? 'stop' : 'be held')
      + ', but has not been yet, so it still shows as being taken. It will appear on the letter and in the patient '
      + 'instructions, and it will be raised for confirmation at the next visit.');
  });

  /* Confirmation is its own act: a different person, at a different time, and the
     answer can be no. Only this converts advice into a change to the record. */
  var confirmingId = null;

  function openConfirm(e) {
    confirmingId = e.id;
    $('#proto-confirm-drug').textContent = e.drug + ' ' + e.sub;
    $('#proto-confirm-advice').innerHTML = esc(adviceWording(e.advice)) + '.<br>Planned by ' + esc(e.advice.by)
      + ' on ' + esc(fmtWhen(e.advice.at)) + '. Patient was told: &ldquo;' + esc(e.advice.text) + '&rdquo;';
    $('#proto-confirm-date').value = adviceDate(e.advice) || '';
    $('#proto-confirm-note').value = '';
    openPopup('popup-confirm');
  }

  function resolveAdvice(outcome) {
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
          + (a.outcomeNote ? '. ' + a.outcomeNote : ''), 'Medication record'));
      msg = 'Confirmed. The plan has now become a change to the record, dated when it actually happened rather than when it was planned.';
    } else if (outcome === 'not-done') {
      e.history.push(h(a.resolvedAt, a.resolvedBy, 'Planned change not done',
        'Patient did not ' + (a.action === 'stop' ? 'stop' : 'hold')
          + (a.outcomeNote ? '. ' + a.outcomeNote : ''), 'Medication record'));
      msg = 'Recorded as not done. The medication is unchanged, and the fact that it did not happen is now on the record, '
        + 'which is the part that matters if a decision was going to be made on the assumption that it had been.';
    } else {
      e.history.push(h(a.resolvedAt, a.resolvedBy, 'Plan withdrawn',
        'No longer applicable' + (a.outcomeNote ? '. ' + a.outcomeNote : ''), 'Medication record'));
      msg = 'Withdrawn. The plan is closed without changing the medication.';
    }
    STATE.lastChanged = e.id;
    closePopups();
    render();
    alertBox(outcome === 'done' ? 'success' : '', '<strong>' + esc(e.drug) + '</strong>. ' + msg);
  }

  $('#proto-confirm-yes').addEventListener('click', function () { resolveAdvice('done'); });
  $('#proto-confirm-no').addEventListener('click', function () { resolveAdvice('not-done'); });
  $('#proto-confirm-na').addEventListener('click', function () { resolveAdvice('na'); });

  $('#proto-appt').addEventListener('change', function () {
    STATE.nextAppointment = this.value;
    render();
    alertBox('', this.value
      ? 'Next appointment set to <strong>' + fmtDate(this.value) + '</strong>. Anything anchored to it has been recalculated.'
      : 'Next appointment cleared. Plans anchored to it now show the relative wording, because there is no date to give the patient yet.');
  });

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
      'Medication record'));
    STATE.lastChanged = e.id;
    render();
    alertBox('', '<strong>' + esc(e.drug) + '</strong> is now '
      + (next ? 'marked eye relevant' : 'not marked eye relevant')
      + (e.relevantOverride === null
          ? ', which matches the drug-set default, so no override is stored.'
          : ' for this patient. The drug-set default is unchanged; only the override is stored.')
      + ' Nothing clinical about the medication has changed, but it moves group and changes which shortcodes pick it up.');
  }

  function restart(e) {
    e.status = 'current';
    e.end = null;
    e.stopReason = null;
    e.start = TODAY;
    e.history.push(h(nowStamp(), user().name, 'Restarted', directions(e), 'Medication record'));
    STATE.lastChanged = e.id;
    render();
    alertBox('', '<strong>' + esc(e.drug) + '</strong> restarted on the same record line. The earlier course stays in its history rather than becoming a second entry.');
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

  function openHistory(e) {
    $('#proto-history-drug').textContent = e.drug + ' ' + e.sub;
    $('#proto-history-body').innerHTML = e.history.slice().reverse().map(function (x) {
      return '<tr><td>' + fmtWhen(x.when) + '</td><td>' + esc(x.who) + '</td><td>' + esc(x.action) + '</td>'
        + '<td>' + esc(x.recordedAs) + '</td><td>' + esc(x.context) + '</td></tr>';
    }).join('');
    openPopup('popup-history');
  }

  /* ---- prescribing ---- */

  /* Generating an order. The form is chosen here, once, so the artefact cannot
     hold a mixture. Location is asked for here too, because it is a property of
     this fulfilment rather than of the patient's treatment. */
  var prescribing = null;

  /* Signing from the element creates the order there and then. There is no
     confirmation dialog in between, because the bar already says what is
     selected and which form it is going on, and nothing the dialog used to
     gather is a clinical direction: the dispensing instruction, the location and
     the note all sit on the order and stay editable until issue without
     disturbing the signature. The directions themselves freeze at signature. */
  function prescribeFromBar(form, sign) {
    var all = selectedEntries();
    var included = all.filter(function (e) { return orderableForms(e).indexOf(form) >= 0; });
    if (!included.length) return;
    prescribing = { form: form, entries: included };
    createOrder(sign);
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

    /* Printing is a real-world side effect and cannot be undone by cancelling a
       form, so the record is committed first and the order is created from the
       committed state. A prescriber can never order from changes that exist only
       in a browser. */
    var committedNow = commitEvent().length;

    var a = rx({
      id: 'RX-' + (++STATE.rxSeq),
      date: TODAY,
      prescriber: user().name,
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
    /* Signing snapshots the directions. An order saved as a draft holds none of
       its own and goes on projecting the record until somebody signs it. */
    if (sign) signArtefact(a);
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
    alertBox('success', '<strong>' + a.id + '</strong> created as ' + esc(f.label.toLowerCase())
      + (sign ? ', signed' : ', unsigned')
      + (committedNow ? '. ' + committedNow + ' unsaved medication change'
          + (committedNow === 1 ? ' was' : 's were') + ' committed first, because an order cannot be '
          + 'generated from a record that only exists in the browser' : '')
      + '. It is not frozen yet: set the dispensing instruction and location on the order, change the '
      + 'medication record and it follows. It freezes when it is printed'
      + (f.pharmacy ? ' or when pharmacy starts signing.' : '.')
      + (excludedFromForm(all, form).length
          ? ' ' + esc(excludedFromForm(all, form).map(function (e) { return e.drug; }).join(', '))
            + ' cannot go on this form, so it stays selected for a separate order.'
          : ''));
  }

  $('#proto-commit-save').addEventListener('click', function () {
    var p = commitEvent();
    render();
    alertBox('success', '<strong>Examination saved.</strong> ' + p.length + ' medication change'
      + (p.length === 1 ? '' : 's') + ' written to the record, attributed to ' + esc(user().name)
      + '. The saved view of this examination will show the list as it stands now, with these rows marked, '
      + 'not whatever the list says next year.');
  });

  /* Discard reverts the record to the last commit, which is what cancelling out of
     an examination does today for every other element. Issued orders are untouched:
     they are not children of the event and paper cannot be un-printed. */
  $('#proto-commit-discard').addEventListener('click', function () {
    var n = pendingChanges().length;
    STATE.entries = JSON.parse(JSON.stringify(STATE.committed));
    STATE.selected = [];
    render();
    alertBox('', n + ' unsaved change' + (n === 1 ? '' : 's') + ' discarded. '
      + 'Any order already issued is unaffected, because it is not part of this event.');
  });

  /* ---- sign ---- */

  var signingId = null;

  function openSign(id) {
    var a = rxById(id);
    signingId = id;
    $('#proto-sign-user').textContent = user().name;
    $('#proto-sign-pin').value = '';
    $('#proto-sign-body').innerHTML = artefactItems(a).map(function (i) {
      var s = i.snapshot;
      var dirs = [s.dose + (s.unit === 'drop' ? ' drop' + (s.dose === '1' ? '' : 's') : s.unit), s.freq, s.route];
      if (s.lat) dirs.push(s.lat);
      return '<tr><td>' + esc(i.drug) + '<span class="proto-drug-sub">' + esc(i.sub) + '</span></td>'
        + '<td>' + esc(dirs.join(', ')) + '</td><td>' + esc(COND_LABELS[i.supply] || i.supply) + '</td></tr>';
    }).join('');
    openPopup('popup-sign');
    $('#proto-sign-pin').focus();
  }

  /* Same auto-submit as the create dialog, and as EsignWidget everywhere else. */
  $('#proto-sign-pin').addEventListener('input', function () {
    if (!/^\d{6}$/.test(this.value)) return;
    var a = rxById(signingId);
    if (!a) return;
    signArtefact(a);
    closePopups();
    render();
    alertBox('success', '<strong>' + esc(a.id) + '</strong> signed by ' + esc(a.signedBy)
      + '. These directions are now snapshotted, so a later change to the medication record will not alter this order. '
      + 'To amend it, void the signature and sign again.');
  });

  /* ---- void and re-sign ---- */

  /* The amendment route for a signed order. The order keeps its number, so the
     forgotten drug does not become a second prescription. Restricted to
     prescribers: a colleague editing the record cannot touch a signed order. */
  function rxVoid(id) {
    var a = rxById(id);
    if (!user().canPrescribe) {
      alertBox('', 'Only a prescriber can void a signature. You can change the medication record, but the signed order will keep saying what was signed.');
      return;
    }
    voidSignature(a, 'Amended before issue');
    render();
    alertBox('', '<strong>' + esc(a.id) + '</strong> is a draft again and its snapshot has been discarded, so it follows the record until it is signed. '
      + esc(a.signatures[a.signatures.length - 1].by) + '\u2019s previous signature is kept in the order history along with what it covered.');
  }

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
        /* A correction stays on the same form as the order it replaces. */
        formType: a.formType,
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
  /* The booked appointment is three weeks out from whenever this is opened. */
  var booked = $('#proto-appt-booked');
  booked.value = STATE.nextAppointment;
  booked.textContent = fmtDate(STATE.nextAppointment);
  STATE.committed = cloneEntries();
  switchView('record');
  render();
})();
