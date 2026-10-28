/* Nomination Form Filler - core logic (parsing + PDF filling).
   Works in the browser (window.NomCore) and in Node (globalThis.NomCore). */
(function (root) {
  'use strict';

  const RELATIONSHIPS = ['Husband', 'Wife', 'Son', 'Daughter', 'Father', 'Mother', 'Brother', 'Sister', 'Others'];
  const STATUSES = ['Married', 'Single', 'Divorced', 'Widowed'];

  // ---------- helpers ----------
  const clean = s => (s || '').replace(/[\[\]{}|“”"‘’~]/g, ' ').replace(/\s+/g, ' ').trim();
  const digits = s => (s || '').replace(/\D/g, '');
  const cols = line => line.replace(/[\[\]{}|“”"~]/g, ' ').split(/\s{2,}/).map(s => s.trim()).filter(Boolean);

  function formatNric(raw) {
    const d = digits(raw);
    if (d.length === 12) return `${d.slice(0, 6)}-${d.slice(6, 8)}-${d.slice(8)}`;
    // OCR sometimes prefixes a stray "1" from a table border
    if (d.length === 13 && d[0] === '1') return formatNric(d.slice(1));
    return clean(raw);
  }

  // Malaysian NRIC: YYMMDD-PB-###G, last digit odd = male
  function infoFromNric(nric) {
    const d = digits(nric);
    if (d.length !== 12) return null;
    const yy = +d.slice(0, 2), mm = +d.slice(2, 4), dd = +d.slice(4, 6);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const nowYY = new Date().getFullYear() % 100;
    const year = (yy > nowYY ? 1900 : 2000) + yy;
    return {
      dobDay: String(dd).padStart(2, '0'), dobMonth: String(mm).padStart(2, '0'), dobYear: String(year),
      gender: (+d[11]) % 2 === 1 ? 'Male' : 'Female'
    };
  }

  function mapRelationship(rel, proposerGender) {
    const r = clean(rel).toLowerCase();
    const hit = RELATIONSHIPS.find(x => x.toLowerCase() === r);
    if (hit && hit !== 'Others') return { relationship: hit, relationshipOther: '' };
    if (r === 'spouse') return { relationship: proposerGender === 'M' ? 'Wife' : proposerGender === 'F' ? 'Husband' : 'Others', relationshipOther: proposerGender ? '' : 'Spouse' };
    if (!r) return { relationship: '', relationshipOther: '' };
    return { relationship: 'Others', relationshipOther: clean(rel) };
  }

  function blankPerson() {
    return {
      name: '', nric: '', passport: '', ppDay: '', ppMonth: '', ppYear: '', gender: '', dobDay: '', dobMonth: '', dobYear: '',
      nationality: 'Malaysian', nationalityOther: '', relationship: '', relationshipOther: '', share: '',
      addr1: '', addr2: '', addr3: '', postcode: '', town: '', country: 'MALAYSIA',
      countryOfBirth: 'Malaysian', countryOfBirthOther: '', tel: '', telCountry: 'MALAYSIA', telType: ''
    };
  }

  // ---------- parsing the ePartner "Policy Detail Information" printout ----------
  function parseCustomerText(text) {
    const lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
    const all = lines.join('\n');
    const out = { warnings: [], found: {} };
    const idxOf = (re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i; return -1; };

    // Policy number
    let m = all.match(/P\s*\/\s*N\s*:?\s*(\d[\d ]{6,14}\d)/i);
    if (m) out.policyNo = digits(m[1]);

    // Proposer / life assured rows of the "Insured" table
    const rowRe = /^\W*(Proposer|Life Assured)\W+(.*?)\W+([MF])\W+(\d[\d\- ]{11,15}\d)\W+\S+\W+(\d{2}\/\d{2}\/\d{4})(.*)$/i;
    const rows = {};
    for (const l of lines) {
      const r = l.match(rowRe);
      if (r) rows[r[1].toLowerCase()] = { name: clean(r[2]), gender: r[3].toUpperCase(), nric: formatNric(r[4]), dob: r[5], rest: r[6] };
    }
    const prop = rows.proposer || rows['life assured'];
    if (prop) {
      out.proposerGender = prop.gender;
      out.proposerNric = prop.nric;
      out.proposerName = prop.name;
      out.proposerDob = prop.dob;
    }
    // Religion - proposer row first, else life assured row when it is the same person
    const relig = r => r && (/non[\s-]*mus/i.test(r.rest) ? 'No' : /mus(l|1)?im/i.test(r.rest) ? 'Yes' : '');
    out.muslim = relig(rows.proposer) ||
      (rows['life assured'] && (!prop || digits(rows['life assured'].nric) === digits(prop.nric)) ? relig(rows['life assured']) : '') || '';

    // Payer details (usually the proposer) - nicer spacing for the name, plus contact + address
    const payerIdx = idxOf(/PAYER\s+DETAILS/i);
    const payeeIdx = idxOf(/PAYEE\s+DETAILS/i, Math.max(payerIdx, 0));
    const payerStart = payerIdx >= 0 ? payerIdx : Math.max(0, idxOf(/^\W*Title\b/i));
    const payerEnd = payeeIdx >= 0 ? payeeIdx : Math.min(lines.length, payerStart + 12);
    const payer = lines.slice(payerStart, payerEnd);
    let payerName = '', payerId = '';
    for (const l of payer) {
      let r;
      if (!payerName && (r = l.match(/^\W*Name\W+([A-Z@'.\/ ,-]{3,})/i))) payerName = clean(r[1]);
      if (!payerId && (r = l.match(/^\W*ID\s*No\W+(\d[\d\- ]{11,15}\d)/i))) payerId = formatNric(r[1]);
      if (!out.email && (r = l.match(/Email\W+(\S+@\S+)/i))) out.email = r[1].replace(/^[^a-z0-9]+/i, '');
      if (!out.mobile && (r = l.match(/Mobile\s*No\W+(\+?\d[\d -]{6,})/i))) out.mobile = digits(r[1]);
    }
    const samePerson = !prop || !payerId || digits(payerId) === digits(prop.nric);
    if (payerName && samePerson) out.proposerName = payerName;
    if (!out.proposerNric && payerId) out.proposerNric = payerId;
    if (out.mobile && !out.mobile.startsWith('0') && out.mobile.length <= 10) out.mobile = '0' + out.mobile;

    // Address: right-hand column starting at "Address", running until PAYEE DETAILS
    const aIdx = payer.findIndex(l => /\bAddress\b/i.test(l) && !/Invalid Address/i.test(l));
    if (aIdx >= 0 && samePerson) {
      const parts = [];
      const first = payer[aIdx].split(/\bAddress\b/i).pop();
      parts.push(clean(first));
      for (let i = aIdx + 1; i < payer.length; i++) {
        const c = cols(payer[i]);
        if (!c.length) continue;
        let seg = c[c.length - 1];
        if (/^(Office Tel|Residence Tel|Mobile)/i.test(seg) || seg === '-') continue;
        parts.push(clean(seg));
      }
      // stray "1" from cell borders: "16601 BLOCK C" -> keep as is unless obviously wrong; user reviews
      const addrLines = parts.filter(Boolean);
      const joined = addrLines.join('\n');
      const pc = joined.match(/\b(\d{5})\b(?![\s\S]*\b\d{5}\b)/);
      if (pc) {
        const before = joined.slice(0, pc.index).split('\n').map(clean).filter(Boolean);
        const after = clean(joined.slice(pc.index + 5).replace(/\n/g, ' '));
        out.address = { lines: before.slice(0, 3), postcode: pc[1], town: after, country: 'MALAYSIA' };
        if (before.length > 3) out.address.lines[2] = before.slice(2).join(', ');
      } else {
        out.address = { lines: addrLines.slice(0, 3), postcode: '', town: '', country: 'MALAYSIA' };
      }
    }

    // Existing nominee(s)
    const nIdx = idxOf(/NOMINEE\s+INFORMATION/i);
    out.nominees = [];
    if (nIdx >= 0) {
      const stop = idxOf(/Explanatory|Trust\s*Created|ALTERNATE POLICY/i, nIdx + 1);
      for (let i = nIdx + 1; i < (stop >= 0 ? stop : nIdx + 8); i++) {
        const l = lines[i];
        if (!l.trim() || /Relationship/i.test(l) && /Name/i.test(l)) continue;
        const c = cols(l);
        if (c.length < 2) continue;
        const name = clean(c[c.length - 1]);
        const rel = clean(c[c.length - 2]);
        if (/^[A-Za-z][A-Za-z ]{1,20}$/.test(rel) && /^[A-Z@'.\/ ,-]{3,}$/i.test(name)) out.nominees.push({ relationshipRaw: rel, name });
      }
    }
    m = all.match(/Trust\s*Created\W*?\s+(\S+)/i);
    out.trustCreated = !m ? '' : /^\W*N\b/i.test(m[1]) ? 'N' : /^\W*[Y4V¥\\]+\W*$/i.test(m[1]) ? 'Y' : '';

    // Servicing agent (usually the witness)
    const agIdx = idxOf(/AGENT\s+DETAILS/i);
    if (agIdx >= 0) {
      for (let i = agIdx + 1; i < Math.min(lines.length, agIdx + 8); i++) {
        let r;
        if (!out.agentName && (r = lines[i].match(/^\W*Name\W+([A-Z@'.\/ ,-]{3,})/i))) out.agentName = clean(r[1]);
        if (!out.agentCode && (r = lines[i].match(/^\W*A\W?[\/I1l]?\W?C\s*No\W+(\w{5,10})/i))) out.agentCode = r[1];
        if (/Immediate officer/i.test(lines[i])) break;
      }
    }

    for (const [k, label] of [['policyNo', 'Policy No'], ['proposerName', 'Proposer name'], ['proposerNric', 'Proposer NRIC'], ['address', 'Address'], ['agentName', 'Agent name']])
      if (!out[k]) out.warnings.push(`${label} not found - please enter it manually.`);
    return out;
  }

  // Build the editable application state from parsed details
  function buildState(parsed) {
    const p = parsed || {};
    const addr = p.address || { lines: [], postcode: '', town: '', country: 'MALAYSIA' };
    const proposerAddr = {
      addr1: addr.lines[0] || '', addr2: addr.lines[1] || '', addr3: addr.lines[2] || '',
      postcode: addr.postcode || '', town: addr.town || '', country: addr.country || 'MALAYSIA'
    };
    const nominees = (p.nominees || []).slice(0, 4).map((n, i, arr) => {
      const person = Object.assign(blankPerson(), proposerAddr, { name: n.name }, mapRelationship(n.relationshipRaw, p.proposerGender));
      if (person.relationship === 'Mother' || person.relationship === 'Wife' || person.relationship === 'Daughter' || person.relationship === 'Sister') person.gender = 'Female';
      if (person.relationship === 'Father' || person.relationship === 'Husband' || person.relationship === 'Son' || person.relationship === 'Brother') person.gender = 'Male';
      person.share = arr.length === 1 ? '100' : '';
      return person;
    });
    if (!nominees.length) nominees.push(Object.assign(blankPerson(), proposerAddr, { share: '100' }));
    const married = nominees.some(n => n.relationship === 'Husband' || n.relationship === 'Wife');
    const today = new Date();
    return {
      proposalNo: '', policyNo: p.policyNo || '',
      proposer: {
        name: p.proposerName || '', nric: p.proposerNric || '', muslim: p.muslim || '', gender: p.proposerGender || '',
        status: married ? 'Married' : '', children: '', childrenCount: '', ...proposerAddr, mobile: p.mobile || '', email: p.email || ''
      },
      nominees,
      trustees: [],
      trusteeAction: '', // 1-4 => Part 2 options
      witnessIsAgent: true,
      witness: Object.assign(blankPerson(), { name: p.agentName || '', iac: p.agentCode || '' }),
      declDate: `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`,
      consents: [],
      meta: { trustCreated: p.trustCreated || '', existingNominees: p.nominees || [], warnings: p.warnings || [] }
    };
  }

  // ---------- PDF filling ----------
  // Appearance for comb (one-character-per-box) fields: background, border, box dividers,
  // and each character centred in its own box, the same way the blank form draws its boxes.
  function combAppearance(L) {
    const color = (arr) => {
      if (!arr) return null;
      const n = arr.asArray().map(x => x.asNumber());
      if (n.length === 1) return L.grayscale(n[0]);
      if (n.length === 3) return L.rgb(n[0], n[1], n[2]);
      if (n.length === 4) return L.cmyk(n[0], n[1], n[2], n[3]);
      return null;
    };
    return (field, widget, font) => {
      const { width: w, height: h } = widget.getRectangle();
      const mk = widget.dict.lookup(L.PDFName.of('MK'));
      const bg = mk && color(mk.lookup(L.PDFName.of('BG')));
      const bc = mk && color(mk.lookup(L.PDFName.of('BC')));
      const n = field.getMaxLength() || 1, cw = w / n;
      const da = (field.acroField.getDefaultAppearance() || '').match(/([\d.]+)\s+Tf/);
      const chars = [...(field.getText() || '')];
      const widest = Math.max(1, ...chars.map(c => font.widthOfTextAtSize(c, 1)));
      const size = Math.min(da && +da[1] > 0 ? +da[1] : 10, (h - 2) * 0.82, (cw - 2) / widest);
      const y = (h - font.heightAtSize(size, { descender: false })) / 2;
      const ops = [L.pushGraphicsState()];
      if (bg) ops.push(L.setFillingColor(bg), L.rectangle(0, 0, w, h), L.fill());
      if (bc) {
        ops.push(L.setStrokingColor(bc), L.setLineWidth(1), L.rectangle(0.5, 0.5, w - 1, h - 1), L.stroke());
        for (let i = 1; i < n; i++) ops.push(L.moveTo(i * cw, h - 0.5), L.lineTo(i * cw, 0.5));
        ops.push(L.stroke());
      }
      ops.push(L.beginMarkedContent('Tx'), L.beginText(), L.setFillingGrayscaleColor(0), L.setFontAndSize(font.name, size));
      let x0 = 0;
      chars.forEach((c, i) => {
        const x = i * cw + (cw - font.widthOfTextAtSize(c, size)) / 2;
        ops.push(L.moveText(x - x0, i === 0 ? y : 0), L.showText(font.encodeText(c)));
        x0 = x;
      });
      ops.push(L.endText(), L.endMarkedContent(), L.popGraphicsState());
      return ops;
    };
  }

  async function fillNomination(templateBytes, s, PDFLib) {
    const { PDFDocument, PDFName } = PDFLib;
    const pdf = await PDFDocument.load(templateBytes);
    const form = pdf.getForm();
    const log = [];
    const helv = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);

    const text = (name, value) => {
      if (value === undefined || value === null || value === '') return;
      let f;
      try { f = form.getTextField(name); } catch { log.push('missing field ' + name); return; }
      let v = String(value);
      const max = f.getMaxLength();
      if (max === 2 && /^\d{4}$/.test(v)) v = v.slice(2); // year boxes take YY
      if (max && v.length > max) { log.push(`${name}: "${v}" cut to ${max} characters`); v = v.slice(0, max); }
      try { f.setText(v); } catch (e) { log.push(`${name}: ${e.message}`); }
      // Auto-size fields (font size 0) blow short text up to fill the box; keep it at form size.
      const da = (f.acroField.getDefaultAppearance() || '').match(/([\d.]+)\s+Tf/);
      if (!f.isCombed() && da && +da[1] === 0) {
        const r = f.acroField.getWidgets()[0].getRectangle();
        const fit = (r.width - 4) / Math.max(1, helv.widthOfTextAtSize(v, 1));
        f.setFontSize(Math.max(6, Math.min(11, (r.height - 2) * 0.75, fit)));
      }
    };
    const choice = (name, idx) => {
      if (!idx) return;
      let f;
      try { f = form.getCheckBox(name); } catch { log.push('missing checkbox ' + name); return; }
      const val = PDFName.of('Choice' + idx);
      f.acroField.dict.set(PDFName.of('V'), val);
      for (const w of f.acroField.getWidgets()) {
        const on = w.getOnValue();
        w.setAppearanceState(on && on.toString() === val.toString() ? on : PDFName.of('Off'));
      }
    };
    const idx = (list, v) => { const i = list.indexOf(v); return i >= 0 ? i + 1 : 0; };
    const yn = v => (v === 'No' ? 1 : v === 'Yes' ? 2 : 0);
    const nat = v => (v === 'Malaysian' ? 1 : v === 'Others' ? 2 : 0);
    const sex = v => (v === 'Male' ? 1 : v === 'Female' ? 2 : 0);
    const maxLen = name => { try { return form.getTextField(name).getMaxLength() || 999; } catch { return 999; } };
    // Spread words over several boxed (comb) lines, wrapping at each line's box count
    const wrap = (names, value) => {
      const ls = names.map(() => '');
      let k = 0;
      for (const w of String(value || '').split(/\s+/).filter(Boolean)) {
        while (k < names.length - 1 && ls[k] && (ls[k] + ' ' + w).length > maxLen(names[k])) k++;
        ls[k] = ls[k] ? ls[k] + ' ' + w : w;
      }
      names.forEach((n, i) => text(n, ls[i]));
    };
    const name3 = (prefix, name) => wrap([prefix + 'Name1', prefix + 'Name2', prefix + 'Name3'], name);
    // NRIC boxes take the 12 digits only; passports are kept as typed
    const idNo = (name, v) => text(name, /^\d{6}-?\d{2}-?\d{4}$/.test((v || '').trim()) ? digits(v) : v);
    const addr = (prefix, p) => {
      const mail = [prefix + 'Mailing1', prefix + 'Mailing2', prefix + 'Mailing3'];
      const given = [p.addr1, p.addr2, p.addr3];
      if (given.every((v, i) => (v || '').length <= maxLen(mail[i]))) mail.forEach((n, i) => text(n, given[i]));
      else wrap(mail, given.filter(Boolean).join(', '));
      text(prefix + 'Postcode', p.postcode); text(prefix + 'Town', p.town); text(prefix + 'Country', p.country);
    };
    const dob = (prefix, p) => { text(prefix + 'DOB Day', p.dobDay); text(prefix + 'DOB Month', p.dobMonth); text(prefix + 'DOB Year', p.dobYear); };

    // Header
    text('Proposal No', s.proposalNo);
    text('Policy No', s.policyNo);

    // Proposer
    const P = s.proposer;
    text('Proposer Name', P.name);
    idNo('Proposer NRIC', P.nric);
    choice('Proposer Muslim', yn(P.muslim));
    choice('Proposer Status', idx(STATUSES, P.status));
    choice('Proposer Children', yn(P.children));
    if (P.children === 'Yes') text('No. of Children', P.childrenCount);
    text('Proposer Name2', P.name); // signature name lines (pages 3 & 4)

    // Nominees
    s.nominees.slice(0, 4).forEach((n, i) => {
      const k = `N${i + 1} `;
      name3(k, n.name);
      idNo(k + 'NRIC', n.nric);
      text(k + 'Passport', n.passport);
      choice(k + 'Gender', sex(n.gender));
      dob(k, n);
      choice(k + 'Nationality', nat(n.nationality));
      if (n.nationality === 'Others') text(k + 'Nationality Others', n.nationalityOther);
      choice(k + 'Relationship', idx(RELATIONSHIPS, n.relationship));
      if (n.relationship === 'Others') text(k + 'Relationship Others', n.relationshipOther);
      text(k + 'percent', n.share);
      addr(k, n);
    });
    // 'Total %' and 'Total 1' are the form's own unprinted check fields; its script fills them.

    // Witness for the proposer's declaration (page 3)
    const W = s.witness;
    text('W1 Name', W.name);
    if (s.witnessIsAgent) text('IAC No 1', W.iac);
    else {
      name3('W1 ', W.name); idNo('W1 NRIC', W.nric); text('W1 Passport', W.passport); dob('W1 ', W); addr('W1 ', W);
    }
    text('Declaration Date', digits(s.declDate)); // 8 boxes: DDMMYYYY

    // Part 2: trustees
    if (s.trustees.length) {
      choice('Part 2', s.trusteeAction || 1);
      s.trustees.slice(0, 2).forEach((t, i) => {
        const k = `T${i + 1} `;
        name3(k, t.name);
        idNo(k + 'NRIC', t.nric); text(k + 'Passport', t.passport);
        choice(k + 'Gender', sex(t.gender)); dob(k, t);
        choice(k + 'Nationality', nat(t.nationality));
        if (t.nationality === 'Others') text(k + 'Nationality Others', t.nationalityOther);
        choice(k + 'Country of Birth', nat(t.countryOfBirth));
        if (t.countryOfBirth === 'Others') text(k + 'Country of Birth Others', t.countryOfBirthOther);
        text(k + 'Tel No', t.tel); text(k + 'Tel Country', t.telCountry);
        choice(k + 'Tels', idx(['House', 'Handphone', 'Office'], t.telType));
        addr(k, t);
        text(`T${i + 1} Name`, t.name); // signature name
      });
      text('W2 Name', W.name);
      if (s.witnessIsAgent) text('IAC No 2', W.iac);
      else { name3('W2 ', W.name); idNo('W2 NRIC', W.nric); text('W2 Passport', W.passport); dob('W2 ', W); addr('W2 ', W); }
      const [dd, mm, yy] = (s.declDate || '').split('/');
      text('Day2', dd); text('Month2', mm); text('Year2', yy);
    } else if (s.trusteeAction === '4') {
      choice('Part 2', 4); // revoke all existing trustees
    }

    // Part 3: consent of existing nominee(s)/trustee(s)
    s.consents.slice(0, 4).forEach((c, i) => {
      const n = i + 1;
      text(`Page 5 Consent${n}`, c.name);
      idNo(`Page 5 Consent1 NRIC${n}`, c.nric);
      text(`Page 5 Witness ${n}`, W.name);
      if (s.witnessIsAgent) text(`Page 5 Witness IAC ${n}`, W.iac);
      else {
        idNo(`Page5_Witness_NRIC${n}`, W.nric);
        text(`Page 5 Witness DOB${n}`, [W.dobDay, W.dobMonth, W.dobYear].join(''));
        text(`Page 5 Witness Passport${n}`, W.passport);
        text(`Page 5 Witness Add${n}`, [W.addr1, W.addr2, W.addr3].filter(Boolean).join(', '));
        text(`Page 5 Witness Postcode${n}`, W.postcode); text(`Page 5 Witness Town${n}`, W.town); text(`Page 5 Witness Country${n}`, W.country);
      }
    });

    // Redraw filled box fields ourselves: pdf-lib's default drops the box dividers,
    // so the characters would float in a blank strip instead of sitting in the boxes.
    for (const f of form.getFields()) {
      if (!(f instanceof PDFLib.PDFTextField) || !f.isCombed() || !f.getText()) continue;
      try { f.updateAppearances(helv, combAppearance(PDFLib)); } catch (e) { log.push(`${f.getName()}: ${e.message}`); }
    }
    form.acroForm.dict.delete(PDFName.of('NeedAppearances'));
    const bytes = await pdf.save();
    return { bytes, log };
  }

  // ---------- extra information (typed notes, .txt files, screenshots, IC photos) ----------
  const STATES = /\b(JOHOR|KEDAH|KELANTAN|MELAKA|MALACCA|NEGERI SEMBILAN|PAHANG|PERAK|PERLIS|PULAU PINANG|PENANG|SABAH|SARAWAK|SELANGOR|TERENGGANU|W\.?\s*P\.?|WILAYAH PERSEKUTUAN|KUALA LUMPUR|PUTRAJAYA|LABUAN)\b/i;

  // "12 Jalan X, Taman Y, 13400 Butterworth, Pulau Pinang" -> lines / postcode / town
  function splitAddress(text) {
    const parts = String(text).split(/\n|,/).map(clean).filter(Boolean);
    // keep a lone house number with its street: "12, Jalan Mawar" stays on one line
    for (let i = parts.length - 2; i >= 0; i--) if (/^(no\.?\s*)?[\dA-Z][\dA-Z\-\/]{0,6}$/i.test(parts[i]) && /\d/.test(parts[i]) && !/^\d{5}$/.test(parts[i])) parts.splice(i, 2, `${parts[i]}, ${parts[i + 1]}`);
    const joined = parts.join('\n');
    const pc = joined.match(/\b(\d{5})\b(?![\s\S]*\b\d{5}\b)/);
    let lines = parts, postcode = '', town = '';
    if (pc) {
      lines = joined.slice(0, pc.index).split('\n').map(clean).filter(Boolean);
      const after = joined.slice(pc.index + 5).split('\n').map(clean).filter(Boolean);
      town = after.filter(a => !STATES.test(a) || a.replace(STATES, '').trim()).join(' ').replace(STATES, '').trim() || after.join(' ');
      postcode = pc[1];
    }
    if (lines.length > 3) lines = [lines[0], lines[1], lines.slice(2).join(', ')];
    return { addr1: lines[0] || '', addr2: lines[1] || '', addr3: lines[2] || '', postcode, town: town.toUpperCase() ? town : '' };
  }

  function parseDate(v) {
    let m = String(v).match(/(\d{1,2})\s*[\/.\- ]\s*(\d{1,2})\s*[\/.\- ]\s*(\d{4})/);
    if (m) return { d: m[1].padStart(2, '0'), m: m[2].padStart(2, '0'), y: m[3] };
    m = String(v).match(/(\d{4})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})/);
    if (m) return { d: m[3].padStart(2, '0'), m: m[2].padStart(2, '0'), y: m[1] };
    return null;
  }
  const normGender = v => /^\s*(m|male|lelaki|man)\b/i.test(v) ? 'Male' : /^\s*(f|female|perempuan|woman)\b/i.test(v) ? 'Female' : '';
  const normYesNo = v => /^\s*(y|yes|ya)\b/i.test(v) ? 'Yes' : /^\s*(n|no|tidak|tiada|none)\b/i.test(v) ? 'No' : '';

  // Label synonyms -> field keys. Order matters: more specific first.
  const LABELS = [
    [/^(proposal)\b/, 'proposalNo'], [/^(policy)\b/, 'policyNo'],
    [/^(declaration\s*date|date\s*of\s*declaration|sign(ing|ature)?\s*date)$/, 'declDate'],
    [/^(marital|status|taraf)/, 'status'], [/^(no\.?\s*of\s*)?(children|child|anak)/, 'children'],
    [/^(muslim|religion|agama)/, 'muslim'],
    [/^(passport\s*expiry|pp\s*expiry)/, 'ppExpiry'], [/^(passport|pp)\b/, 'passport'],
    [/^(nric|ic|i\/c|mykad|new\s*ic|id(\s*no)?|kad\s*pengenalan)\b/, 'nric'],
    [/^(full\s*)?name|^nama/, 'name'],
    [/^(gender|sex|jantina)/, 'gender'], [/^(dob|d\.o\.b|date\s*of\s*birth|birth\s*date|tarikh\s*lahir)/, 'dob'],
    [/^(country\s*of\s*birth|birth\s*country)/, 'countryOfBirth'], [/^(nationality|citizenship|warganegara)/, 'nationality'],
    [/^(relationship|relation|hubungan)/, 'relationship'], [/^(share|%|percent|percentage|portion|bahagian)/, 'share'],
    [/^(address|alamat)\s*(line\s*)?([123])$/, 'addrN'], [/^(address|alamat|mailing)/, 'address'],
    [/^(postcode|post\s*code|poskod|zip)/, 'postcode'], [/^(town|city|bandar)/, 'town'], [/^(country|negara)/, 'country'],
    [/^(tel(ephone)?\s*type|phone\s*type)/, 'telType'], [/^(tel(ephone)?|phone)\s*country/, 'telCountry'], [/^(tel|phone|mobile|hp|handphone|contact)/, 'tel'],
    [/^(iac|agent\s*code|agent\s*no|a\/c\s*no)/, 'iac'], [/^((trustee\s*)?(action|instruction))/, 'trusteeAction']
  ];

  const LABEL_NAMES = { policyNo: 'Policy no.', proposalNo: 'Proposal no.', declDate: 'Declaration date', status: 'Marital status', children: 'Children', muslim: 'Muslim',
    ppExpiry: 'Passport expiry', passport: 'Passport', nric: 'NRIC', name: 'Name', gender: 'Gender', dob: 'Date of birth', countryOfBirth: 'Country of birth',
    nationality: 'Nationality', relationship: 'Relationship', share: 'Share %', addrN: 'Address line', address: 'Address', postcode: 'Postcode', town: 'Town',
    country: 'Country', telType: 'Tel type', telCountry: 'Tel country', tel: 'Tel no.', iac: 'IAC no.', trusteeAction: 'Trustee instruction' };

  // Section heading or label prefix: "Nominee 2", "Trustee", "Witness", "Proposer"
  const SECTION = /^(nominee|penama|beneficiary|trustee|pemegang\s*amanah|witness|saksi|proposer|policy\s*owner|policyowner|customer|pencadang)\s*(\d)?\b\s*[:\-–]?\s*/i;
  const sectionOf = (word, n) => {
    const w = word.toLowerCase();
    if (/nominee|penama|beneficiary/.test(w)) return { list: 'nominees', i: (+n || 1) - 1 };
    if (/trustee|amanah/.test(w)) return { list: 'trustees', i: (+n || 1) - 1 };
    if (/witness|saksi/.test(w)) return { list: 'witness' };
    return { list: 'proposer' };
  };

  // Returns { patch, person, found[] }. patch = labelled values per section; person = details read off an ID card
  function parseExtraText(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const patch = { top: {}, proposer: {}, witness: {}, nominees: [], trustees: [] };
    const found = [];
    let sec = null;
    const target = s => s.list === 'nominees' || s.list === 'trustees' ? (patch[s.list][s.i] = patch[s.list][s.i] || {}) : patch[s.list];
    const where = s => s.list === 'nominees' ? 'Nominee ' + (s.i + 1) : s.list === 'trustees' ? 'Trustee ' + (s.i + 1) : s.list === 'top' ? 'Form' : s.list[0].toUpperCase() + s.list.slice(1);
    const FORM_KEYS = ['policyNo', 'proposalNo', 'declDate', 'trusteeAction'];
    for (let line of lines) {
      if (line.startsWith('#')) continue; // comment line in the answer sheet
      let lineSec = null, m = line.match(SECTION);
      if (m) {
        lineSec = sectionOf(m[1], m[2]);
        line = line.slice(m[0].length);
        if (!line.trim()) { sec = lineSec; continue; } // heading line
      }
      const kv = line.match(/^([A-Za-z%][A-Za-z0-9 .\/()%'-]{0,40}?)\s*[:=]\s*(.+)$/) || line.match(/^([A-Za-z][A-Za-z .\/]{1,30}?)\s+-\s+(.+)$/);
      if (!kv) continue;
      const label = kv[1].trim().toLowerCase(), value = kv[2].trim();
      if (/^\[.*\]$/.test(value)) continue; // unanswered [choice] placeholder
      const hit = LABELS.find(([re]) => re.test(label));
      if (!hit) continue;
      const key = hit[1];
      const s = FORM_KEYS.includes(key) ? { list: 'top' } : ['status', 'children', 'muslim'].includes(key) ? { list: 'proposer' }
        : lineSec || sec || { list: 'nominees', i: 0 };
      const t = target(s);
      switch (key) {
        case 'policyNo': case 'proposalNo': patch.top[key] = digits(value) || value; break;
        case 'declDate': { const d = parseDate(value); if (d) patch.top.declDate = `${d.d}/${d.m}/${d.y}`; break; }
        case 'trusteeAction': { const n = value.match(/[1-4]/); if (n) patch.top.trusteeAction = n[0]; else if (/revoke.*appoint/i.test(value)) patch.top.trusteeAction = '3'; else if (/revoke/i.test(value)) patch.top.trusteeAction = '4'; else if (/addition/i.test(value)) patch.top.trusteeAction = '2'; else patch.top.trusteeAction = '1'; break; }
        case 'status': { const st = STATUSES.find(x => new RegExp('^' + x.slice(0, 4), 'i').test(value)) || (/bujang/i.test(value) ? 'Single' : /kahwin/i.test(value) ? 'Married' : /cerai/i.test(value) ? 'Divorced' : /balu|duda/i.test(value) ? 'Widowed' : ''); if (st) patch.proposer.status = st; break; }
        case 'children': { const n = value.match(/\d+/); if (n && +n[0] > 0) { patch.proposer.children = 'Yes'; patch.proposer.childrenCount = n[0]; } else if (n || normYesNo(value)) patch.proposer.children = n ? 'No' : normYesNo(value); break; }
        case 'muslim': patch.proposer.muslim = /non|bukan/i.test(value) ? 'No' : /muslim|islam/i.test(value) ? 'Yes' : normYesNo(value) || 'No'; break;
        case 'nric': t.nric = formatNric(value); break;
        case 'passport': t.passport = clean(value).toUpperCase(); break;
        case 'ppExpiry': { const d = parseDate(value); if (d) Object.assign(t, { ppDay: d.d, ppMonth: d.m, ppYear: d.y }); break; }
        case 'name': t.name = clean(value).toUpperCase(); break;
        case 'gender': if (normGender(value)) t.gender = normGender(value); break;
        case 'dob': { const d = parseDate(value); if (d) Object.assign(t, { dobDay: d.d, dobMonth: d.m, dobYear: d.y }); break; }
        case 'nationality': if (/malaysia/i.test(value)) t.nationality = 'Malaysian'; else { t.nationality = 'Others'; t.nationalityOther = clean(value).toUpperCase(); } break;
        case 'countryOfBirth': if (/malaysia/i.test(value)) t.countryOfBirth = 'Malaysian'; else { t.countryOfBirth = 'Others'; t.countryOfBirthOther = clean(value).toUpperCase(); } break;
        case 'relationship': Object.assign(t, mapRelationship(value)); if (/spouse/i.test(value)) t.relationshipRaw = value; break;
        case 'share': { const n = value.match(/\d+(\.\d+)?/); if (n) t.share = n[0]; break; }
        case 'address': Object.assign(t, splitAddress(value.toUpperCase())); break;
        case 'addrN': t['addr' + label.match(/[123]$/)[0]] = clean(value).toUpperCase(); break;
        case 'postcode': t.postcode = digits(value); break;
        case 'town': t.town = clean(value).toUpperCase(); break;
        case 'country': t.country = clean(value).toUpperCase(); break;
        case 'tel': t.tel = value.replace(/[^\d+]/g, ''); { const ty = value.match(/house|home|rumah|office|pejabat|hand|mobile|hp/i); if (ty) t.telType = /house|home|rumah/i.test(ty[0]) ? 'House' : /office|pejabat/i.test(ty[0]) ? 'Office' : 'Handphone'; } break;
        case 'telCountry': t.telCountry = clean(value).toUpperCase(); break;
        case 'telType': t.telType = /house|home/i.test(value) ? 'House' : /office/i.test(value) ? 'Office' : 'Handphone'; break;
        case 'iac': t.iac = clean(value); break;
      }
      found.push(`${where(s)} · ${LABEL_NAMES[key] || key}: ${value}`);
    }
    if (found.length) return { patch, found };
    const person = parseIdCard(lines);
    if (!person) return { found: [] };
    const p = person, dob = p.dobDay ? `${p.dobDay}/${p.dobMonth}/${p.dobYear}` : '';
    const addr = [p.addr1, p.addr2, p.addr3, [p.postcode, p.town].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return { person, found: [['Name', p.name], ['NRIC', p.nric], ['Gender', p.gender], ['Date of birth', dob], ['Address', addr]].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`) };
  }

  // MyKad / passport photo: NRIC number, name (capital lines after it), address, gender
  function parseIdCard(lines) {
    const all = lines.join('\n');
    const m = all.match(/\b(\d{6})\s*-\s*(\d{2})\s*-\s*(\d{4})\b/) || all.match(/\b(\d{6})(\d{2})(\d{4})\b/);
    if (!m) return null;
    const p = { nric: `${m[1]}-${m[2]}-${m[3]}` };
    const info = infoFromNric(p.nric);
    if (info) Object.assign(p, info);
    if (/PEREMPUAN/i.test(all)) p.gender = 'Female'; else if (/LELAKI/i.test(all)) p.gender = 'Male';
    if (/WARGANEGARA|MALAYSIA/i.test(all)) p.nationality = 'Malaysian';
    const start = lines.findIndex(l => l.includes(m[0]) || digits(l).includes(m[1] + m[2] + m[3]));
    const rest = lines.slice(start + 1)
      .map(l => l.replace(/[^A-Za-z0-9@'.,\/ -]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(l => l.length > 2 && !/^(MYKAD|KAD PENGENALAN|IDENTITY CARD|MALAYSIA|WARGANEGARA|LELAKI|PEREMPUAN|ISLAM)$/i.test(l));
    const isAddr = l => /^\d|^(NO|LOT|BLOK|BLOCK|JALAN|JLN|LORONG|LRG|TAMAN|TMN|KAMPUNG|KG|APT|PANGSAPURI|UNIT)\b/i.test(l) || /\b\d{5}\b/.test(l);
    const nameLines = [];
    let i = 0;
    for (; i < rest.length && !isAddr(rest[i]); i++) if (/^[A-Z@'.\/ -]+$/.test(rest[i])) nameLines.push(rest[i]);
    if (nameLines.length) p.name = nameLines.slice(0, 2).join(' ');
    const addrLines = rest.slice(i).filter(l => !/^(WARGANEGARA|LELAKI|PEREMPUAN|ISLAM)\b/i.test(l));
    if (addrLines.length) Object.assign(p, splitAddress(addrLines.join('\n').toUpperCase()));
    return p;
  }

  // Merge extra info into the app state. person + target ("nominees.0", "trustees.new", "witness", ...) for ID cards.
  function applyExtra(state, extra, target) {
    const fillDob = t => { const info = infoFromNric(t.nric); if (info) for (const k of ['dobDay', 'dobMonth', 'dobYear', 'gender']) if (!t[k]) t[k] = info[k]; };
    const merge = (t, src) => {
      if (src.addr1) { t.addr2 = ''; t.addr3 = ''; } // a new address replaces the whole old one
      for (const [k, v] of Object.entries(src)) if (v !== '' && v != null && k !== 'relationshipRaw') t[k] = v; fillDob(t); };
    const addrFromProposer = () => { const P = state.proposer; return { addr1: P.addr1, addr2: P.addr2, addr3: P.addr3, postcode: P.postcode, town: P.town, country: P.country }; };
    const slot = (list, i) => {
      while (state[list].length <= i && state[list].length < (list === 'nominees' ? 4 : 2))
        state[list].push(Object.assign(blankPerson(), list === 'nominees' ? addrFromProposer() : {}));
      return state[list][Math.min(i, state[list].length - 1)];
    };
    if (extra.patch) {
      const p = extra.patch;
      Object.assign(state, p.top);
      if (p.proposer.relationship) delete p.proposer.relationship;
      merge(state.proposer, p.proposer);
      merge(state.witness, p.witness);
      if (p.witness.nric || p.witness.addr1) state.witnessIsAgent = false;
      p.nominees.forEach((n, i) => {
        if (!n || !Object.keys(n).length) return;
        const t = slot('nominees', i);
        // "Spouse" depends on the proposer's gender
        if (n.relationshipRaw) Object.assign(n, mapRelationship(n.relationshipRaw, state.proposer.gender ? state.proposer.gender[0] : ''));
        merge(t, n);
      });
      p.trustees.forEach((n, i) => { if (n && Object.keys(n).length) { merge(slot('trustees', i), n); if (!state.trusteeAction) state.trusteeAction = '1'; } });
    }
    if (extra.person && target) {
      const [list, which] = target.split('.');
      if (list === 'witness') { merge(state.witness, extra.person); state.witnessIsAgent = false; }
      else if (list === 'proposer') merge(state.proposer, extra.person);
      else {
        const i = which === 'new' ? state[list].length : +which;
        merge(slot(list, i), extra.person);
        if (list === 'trustees' && !state.trusteeAction) state.trusteeAction = '1';
      }
    }
    return state;
  }

  // Suggest where an ID card belongs: matching NRIC or name, else the first nominee without an NRIC
  function suggestTarget(state, person) {
    const same = (a, b) => a && b && digits(a) === digits(b);
    const nameEq = (a, b) => a && b && clean(a).toUpperCase() === clean(b).toUpperCase();
    if (same(person.nric, state.proposer.nric)) return 'proposer';
    for (const list of ['nominees', 'trustees']) {
      const i = state[list].findIndex(x => same(x.nric, person.nric) || nameEq(x.name, person.name));
      if (i >= 0) return `${list}.${i}`;
    }
    const i = state.nominees.findIndex(x => !x.nric && !x.passport);
    return i >= 0 ? `nominees.${i}` : (state.nominees.length < 4 ? 'nominees.new' : 'trustees.new');
  }

  root.NomCore = { parseCustomerText, buildState, fillNomination, parseExtraText, applyExtra, suggestTarget, infoFromNric, mapRelationship, blankPerson, formatNric, RELATIONSHIPS, STATUSES };
})(typeof window !== 'undefined' ? window : globalThis);
