// temporal-schedule-input.js
// Standards-only, dependency-free, form-associated element.
// Complex strings only for cron; all other inputs are UI-first.

const TPL = document.createElement("template");
TPL.innerHTML = `
  <fieldset part="root">
    <legend part="legend">Schedule</legend>

    <section aria-label="Required">
      <label>
        <span>Mode</span>
        <select name="mode">
          <option value="calendar">Calendar</option>
          <option value="interval">Interval</option>
          <option value="cron">Cron</option>
          <option value="advanced">Advanced (combine)</option>
        </select>
      </label>

      <label>
        <span>Timezone (IANA)</span>
        <input name="time_zone_name" inputmode="text" placeholder="e.g. America/Los_Angeles" />
      </label>

      <!-- Calendar -->
      <section data-panel="calendar" aria-label="Calendar schedule">
        <label>
          <span>Pattern</span>
          <select name="cal_pattern">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </label>

        <fieldset>
          <legend>Times (local)</legend>
          <div data-list="times"></div>
          <button type="button" data-action="add-time">Add time</button>
        </fieldset>

        <fieldset data-show-when="weekly" hidden>
          <legend>Days of week</legend>
          <label><input type="checkbox" data-dow value="0" /> Sun</label>
          <label><input type="checkbox" data-dow value="1" /> Mon</label>
          <label><input type="checkbox" data-dow value="2" /> Tue</label>
          <label><input type="checkbox" data-dow value="3" /> Wed</label>
          <label><input type="checkbox" data-dow value="4" /> Thu</label>
          <label><input type="checkbox" data-dow value="5" /> Fri</label>
          <label><input type="checkbox" data-dow value="6" /> Sat</label>
          <button type="button" data-action="dow-weekdays">Weekdays</button>
          <button type="button" data-action="dow-all">All</button>
          <button type="button" data-action="dow-none">None</button>
        </fieldset>

        <fieldset data-show-when="monthly" hidden>
          <legend>Days of month</legend>
          <div data-list="dom"></div>
          <button type="button" data-action="dom-all">All</button>
          <button type="button" data-action="dom-none">None</button>
        </fieldset>

        <fieldset data-show-when="yearly" hidden>
          <legend>Months</legend>
          <label><input type="checkbox" data-month value="1" /> Jan</label>
          <label><input type="checkbox" data-month value="2" /> Feb</label>
          <label><input type="checkbox" data-month value="3" /> Mar</label>
          <label><input type="checkbox" data-month value="4" /> Apr</label>
          <label><input type="checkbox" data-month value="5" /> May</label>
          <label><input type="checkbox" data-month value="6" /> Jun</label>
          <label><input type="checkbox" data-month value="7" /> Jul</label>
          <label><input type="checkbox" data-month value="8" /> Aug</label>
          <label><input type="checkbox" data-month value="9" /> Sep</label>
          <label><input type="checkbox" data-month value="10" /> Oct</label>
          <label><input type="checkbox" data-month value="11" /> Nov</label>
          <label><input type="checkbox" data-month value="12" /> Dec</label>
          <button type="button" data-action="month-all">All</button>
          <button type="button" data-action="month-none">None</button>

          <legend>Days of month</legend>
          <div data-list="dom-yearly"></div>
          <button type="button" data-action="domy-all">All</button>
          <button type="button" data-action="domy-none">None</button>
        </fieldset>
      </section>

      <!-- Interval -->
      <section data-panel="interval" aria-label="Interval schedule" hidden>
        <div data-list="intervals"></div>
        <button type="button" data-action="add-interval">Add interval</button>
      </section>

      <!-- Cron -->
      <section data-panel="cron" aria-label="Cron schedule" hidden>
        <div data-list="cron"></div>
        <button type="button" data-action="add-cron">Add cron</button>
      </section>

      <!-- Advanced combine -->
      <section data-panel="advanced" aria-label="Advanced combine" hidden>
        <p>Advanced combines Calendars + Intervals + Cron (union), minus skip calendars.</p>

        <h3>Calendars (ranges)</h3>
        <div data-list="adv-calendars"></div>
        <button type="button" data-action="add-adv-calendar">Add calendar</button>

        <h3>Intervals</h3>
        <div data-list="adv-intervals"></div>
        <button type="button" data-action="add-adv-interval">Add interval</button>

        <h3>Cron</h3>
        <div data-list="adv-cron"></div>
        <button type="button" data-action="add-adv-cron">Add cron</button>
      </section>
    </section>

    <details>
      <summary>Advanced options</summary>

      <fieldset>
        <legend>Bounds (local datetime)</legend>
        <label><span>Start at</span> <input name="start_at_local" type="datetime-local" /></label>
        <label><span>End at</span> <input name="end_at_local" type="datetime-local" /></label>
      </fieldset>

      <fieldset>
        <legend>Jitter (optional)</legend>
        <label><span>Jitter</span> <input name="jitter_value" type="number" min="0" step="1" value="0" /></label>
        <label>
          <span>Unit</span>
          <select name="jitter_unit">
            <option value="seconds" selected>seconds</option>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Skip calendars (exclusions)</legend>

        <details>
          <summary>Skip a whole day (helper)</summary>
          <div data-list="skip-day-helper"></div>
          <button type="button" data-action="add-skip-day">Add day</button>
        </details>

        <details>
          <summary>Skip calendar rules (advanced)</summary>
          <div data-list="skip-calendars"></div>
          <button type="button" data-action="add-skip-calendar">Add skip calendar</button>
        </details>
      </fieldset>

      <fieldset>
        <legend>Policy</legend>
        <label>
          <span>Overlap</span>
          <select name="overlap">
            <option value="">(default)</option>
            <option value="SKIP">SKIP</option>
            <option value="BUFFER_ONE">BUFFER_ONE</option>
            <option value="BUFFER_ALL">BUFFER_ALL</option>
            <option value="CANCEL_OTHER">CANCEL_OTHER</option>
            <option value="TERMINATE_OTHER">TERMINATE_OTHER</option>
            <option value="ALLOW_ALL">ALLOW_ALL</option>
          </select>
        </label>

        <label><span>Catchup window</span> <input name="catchup_value" type="number" min="0" step="1" value="0" /></label>
        <label>
          <span>Unit</span>
          <select name="catchup_unit">
            <option value="minutes">minutes</option>
            <option value="hours" selected>hours</option>
            <option value="days">days</option>
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>State</legend>
        <label><span>Paused</span> <input name="paused" type="checkbox" /></label>
        <label><span>Limit actions</span> <input name="limited_actions" type="checkbox" /></label>
        <label><span>Remaining actions</span> <input name="remaining_actions" type="number" min="0" step="1" value="0" /></label>
      </fieldset>
    </details>

    <!-- Templates -->
    <template data-tpl="time-row">
      <div data-kind="time-row">
        <label><span>Time</span> <input name="time_hm" type="time" step="60" /></label>
        <label><span>Seconds</span> <input name="time_s" type="number" min="0" max="59" step="1" value="0" /></label>
        <button type="button" data-action="remove">Remove</button>
      </div>
    </template>

    <template data-tpl="cron-row">
      <div data-kind="cron-row">
        <label><span>Cron</span> <input name="cron_expr" placeholder="e.g. 0 12 * * MON-FRI" /></label>
        <button type="button" data-action="remove">Remove</button>
      </div>
    </template>

    <template data-tpl="interval-row">
      <fieldset data-kind="interval-row">
        <legend>Interval</legend>
        <label><span>Every</span> <input name="every_val" type="number" min="1" step="1" value="1" /></label>
        <label>
          <span>Unit</span>
          <select name="every_unit">
            <option value="seconds">seconds</option>
            <option value="minutes" selected>minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
            <option value="weeks">weeks</option>
          </select>
        </label>

        <label><span>Offset</span> <input name="offset_enabled" type="checkbox" /></label>

        <div data-offset hidden>
          <label><span>Offset</span> <input name="offset_val" type="number" min="0" step="1" value="0" /></label>
          <label>
            <span>Unit</span>
            <select name="offset_unit">
              <option value="seconds" selected>seconds</option>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
          </label>
        </div>

        <button type="button" data-action="remove">Remove</button>
      </fieldset>
    </template>

    <template data-tpl="skip-day-row">
      <div data-kind="skip-day-row">
        <label><span>Date</span> <input name="skip_day" type="date" /></label>
        <button type="button" data-action="remove">Remove</button>
      </div>
    </template>

    <!-- Advanced calendar range editor -->
    <template data-tpl="adv-calendar">
      <fieldset data-kind="adv-calendar">
        <legend>Calendar</legend>
        <label><span>Comment</span> <input name="adv_comment" /></label>
        <button type="button" data-action="remove">Remove calendar</button>

        <details>
          <summary>Ranges (optional)</summary>
          <p>Hour/minute/second default to 0; other fields default to “all”.</p>

          <div data-adv-field="second"></div>
          <button type="button" data-action="add-range" data-field="second">Add second range</button>

          <div data-adv-field="minute"></div>
          <button type="button" data-action="add-range" data-field="minute">Add minute range</button>

          <div data-adv-field="hour"></div>
          <button type="button" data-action="add-range" data-field="hour">Add hour range</button>

          <div data-adv-field="day_of_month"></div>
          <button type="button" data-action="add-range" data-field="day_of_month">Add day-of-month range</button>

          <div data-adv-field="month"></div>
          <button type="button" data-action="add-range" data-field="month">Add month range</button>

          <div data-adv-field="day_of_week"></div>
          <button type="button" data-action="add-range" data-field="day_of_week">Add day-of-week range</button>

          <div data-adv-field="year"></div>
          <button type="button" data-action="add-range" data-field="year">Add year range</button>
        </details>
      </fieldset>
    </template>

    <template data-tpl="range-row">
      <div data-kind="range-row">
        <label><span>Start</span> <input name="r_start" type="number" step="1" /></label>
        <label><span>End</span> <input name="r_end" type="number" step="1" /></label>
        <label><span>Step</span> <input name="r_step" type="number" min="1" step="1" value="1" /></label>
        <button type="button" data-action="remove">Remove</button>
      </div>
    </template>

    <template data-tpl="adv-interval">
      <fieldset data-kind="adv-interval">
        <legend>Interval</legend>
        <label><span>Every (seconds)</span> <input name="every_s" type="number" min="1" step="1" /></label>
        <label><span>Offset (seconds)</span> <input name="offset_s" type="number" min="0" step="1" value="0" /></label>
        <button type="button" data-action="remove">Remove</button>
      </fieldset>
    </template>
  </fieldset>
`;

const unitToSeconds = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
  weeks: 604800,
};

function browserTZ() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

function jsonMaybe(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return JSON.parse(s);
}

function singletonRanges(values) {
  return values.map(v => ({ start: v, end: v, step: 1 }));
}

function parseHHMM(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(s || "");
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
  return { hh, mm };
}

function dayToSkipCalendar(dateStr) {
  // Whole day exclusion: year/month/day fixed + hour/min/sec full
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    year: singletonRanges([year]),
    month: singletonRanges([month]),
    day_of_month: singletonRanges([day]),
    hour: [{ start: 0, end: 23, step: 1 }],
    minute: [{ start: 0, end: 59, step: 1 }],
    second: [{ start: 0, end: 59, step: 1 }],
  };
}

export class TemporalScheduleInput extends HTMLElement {
  static formAssociated = true;
  static observedAttributes = ["value", "disabled", "required"];

  #internals;
  #didInit = false;
  #model = { spec: {}, policy: {}, state: {} };

  constructor() {
    super();
    this.#internals = this.attachInternals();
    this.attachShadow({ mode: "open" }).appendChild(TPL.content.cloneNode(true));
  }

  connectedCallback() {
    if (this.#didInit) return;
    this.#didInit = true;

    this.#qs('input[name="time_zone_name"]').value = browserTZ();

    // Seed DOM checkboxes
    this.#seedDOM(this.#qs('[data-list="dom"]'), "dom");
    this.#seedDOM(this.#qs('[data-list="dom-yearly"]'), "domy");

    this.#wire();

    const attr = this.getAttribute("value");
    if (attr?.trim()) this.#applyValue(attr);
    else {
      const inline = (this.textContent || "").trim();
      if (inline.startsWith("{")) this.#applyValue(inline);
      else this.#seedDefaults();
    }

    this.#updatePanels();
    this.#updateCalendarPattern();
    this.#ensureMinimumRows();
    this.#applyDisabled();
    this.#sync();
  }

  attributeChangedCallback(name) {
    if (name === "value") {
      const v = this.getAttribute("value");
      if (v?.trim()) this.#applyValue(v);
    }
    if (name === "disabled") this.#applyDisabled();
    if (name === "required") this.#sync();
  }

  get value() { return structuredClone(this.#model); }
  set value(v) { this.#applyValue(v); }

  #qs(sel) { return this.shadowRoot.querySelector(sel); }
  #qsa(sel) { return Array.from(this.shadowRoot.querySelectorAll(sel)); }
  #list(name) { return this.#qs(`[data-list="${name}"]`); }
  #tpl(name) { return this.shadowRoot.querySelector(`template[data-tpl="${name}"]`); }

  #applyDisabled() {
    const disabled = this.hasAttribute("disabled");
    this.#qsa("input, select, button, textarea").forEach(el => { el.disabled = disabled; });
  }

  #wire() {
    // Mode switching
    this.#qs('select[name="mode"]').addEventListener("change", () => {
      this.#updatePanels();
      this.#ensureMinimumRows();
      this.#sync();
    });

    // Calendar pattern switching
    this.#qs('select[name="cal_pattern"]').addEventListener("change", () => {
      this.#updateCalendarPattern();
      this.#sync();
    });

    // Buttons
    this.#qs('button[data-action="add-time"]').addEventListener("click", () => { this.#addTimeRow(); this.#sync(); });
    this.#qs('button[data-action="add-cron"]').addEventListener("click", () => { this.#addCronRow("cron"); this.#sync(); });
    this.#qs('button[data-action="add-interval"]').addEventListener("click", () => { this.#addIntervalRow("intervals"); this.#sync(); });

    this.#qs('button[data-action="add-adv-calendar"]').addEventListener("click", () => { this.#addAdvCalendar("adv-calendars"); this.#sync(); });
    this.#qs('button[data-action="add-adv-interval"]').addEventListener("click", () => { this.#addAdvInterval(); this.#sync(); });
    this.#qs('button[data-action="add-adv-cron"]').addEventListener("click", () => { this.#addCronRow("adv-cron"); this.#sync(); });

    this.#qs('button[data-action="add-skip-day"]').addEventListener("click", () => { this.#addSkipDayRow(); this.#sync(); });
    this.#qs('button[data-action="add-skip-calendar"]').addEventListener("click", () => { this.#addAdvCalendar("skip-calendars"); this.#sync(); });

    // Quick actions
    this.#qs('button[data-action="dow-weekdays"]').addEventListener("click", () => { this.#setDOW([1,2,3,4,5]); this.#sync(); });
    this.#qs('button[data-action="dow-all"]').addEventListener("click", () => { this.#setDOW([0,1,2,3,4,5,6]); this.#sync(); });
    this.#qs('button[data-action="dow-none"]').addEventListener("click", () => { this.#setDOW([]); this.#sync(); });

    this.#qs('button[data-action="dom-all"]').addEventListener("click", () => { this.#setDOM("dom", true); this.#sync(); });
    this.#qs('button[data-action="dom-none"]').addEventListener("click", () => { this.#setDOM("dom", false); this.#sync(); });
    this.#qs('button[data-action="domy-all"]').addEventListener("click", () => { this.#setDOM("domy", true); this.#sync(); });
    this.#qs('button[data-action="domy-none"]').addEventListener("click", () => { this.#setDOM("domy", false); this.#sync(); });

    this.#qs('button[data-action="month-all"]').addEventListener("click", () => { this.#setMonths(true); this.#sync(); });
    this.#qs('button[data-action="month-none"]').addEventListener("click", () => { this.#setMonths(false); this.#sync(); });

    // Delegation: remove + add-range + interval offset toggle
    this.shadowRoot.addEventListener("click", (e) => {
      const rm = e.target.closest('button[data-action="remove"]');
      if (rm) { rm.closest("[data-kind]")?.remove(); this.#sync(); return; }

      const addR = e.target.closest('button[data-action="add-range"]');
      if (addR) {
        const field = addR.getAttribute("data-field");
        const cal = addR.closest('[data-kind="adv-calendar"]');
        const holder = cal?.querySelector(`[data-adv-field="${field}"]`);
        if (holder) holder.appendChild(this.#tpl("range-row").content.cloneNode(true));
        this.#sync();
      }
    });

    this.shadowRoot.addEventListener("change", (e) => {
      const row = e.target.closest('[data-kind="interval-row"]');
      if (!row) return;
      if (e.target.matches('input[name="offset_enabled"]')) {
        row.querySelector("[data-offset]").hidden = !e.target.checked;
        this.#sync();
      }
    });

    this.shadowRoot.addEventListener("input", () => this.#sync());
    this.shadowRoot.addEventListener("change", () => this.#sync());
  }

  #seedDefaults() {
    this.#qs('select[name="mode"]').value = "calendar";
    this.#qs('select[name="cal_pattern"]').value = "daily";
    // one single default time
    this.#list("times").innerHTML = "";
    this.#addTimeRow("09:00", 0);
  }

  #updatePanels() {
    const mode = this.#qs('select[name="mode"]').value;
    this.#qsa("[data-panel]").forEach(p => p.hidden = p.getAttribute("data-panel") !== mode);
  }

  #updateCalendarPattern() {
    const pat = this.#qs('select[name="cal_pattern"]').value;
    this.#qsa("[data-show-when]").forEach(fs => {
      fs.hidden = fs.getAttribute("data-show-when") !== pat;
    });
  }

  #ensureMinimumRows() {
    const mode = this.#qs('select[name="mode"]').value;
    if (mode === "calendar" && !this.#list("times").querySelector('[data-kind="time-row"]')) {
      this.#addTimeRow("09:00", 0);
    }
    if (mode === "cron" && !this.#list("cron").querySelector('[data-kind="cron-row"]')) {
      this.#addCronRow("cron");
    }
    if (mode === "interval" && !this.#list("intervals").querySelector('[data-kind="interval-row"]')) {
      this.#addIntervalRow("intervals");
    }
  }

  #seedDOM(container, prefix) {
    const frag = document.createDocumentFragment();
    for (let d = 1; d <= 31; d++) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-dom", prefix);
      cb.value = String(d);
      label.append(cb, ` ${d}`);
      frag.append(label);
    }
    container.appendChild(frag);
  }

  #addTimeRow(hm = "09:00", sec = 0) {
    const node = this.#tpl("time-row").content.cloneNode(true);
    node.querySelector('input[name="time_hm"]').value = hm;
    node.querySelector('input[name="time_s"]').value = String(sec);
    this.#list("times").appendChild(node);
  }

  #addCronRow(listName) {
    const node = this.#tpl("cron-row").content.cloneNode(true);
    this.#list(listName).appendChild(node);
  }

  #addIntervalRow(listName) {
    const node = this.#tpl("interval-row").content.cloneNode(true);
    // hide offset section by default
    node.querySelector("[data-offset]").hidden = true;
    this.#list(listName).appendChild(node);
  }

  #addSkipDayRow() {
    const node = this.#tpl("skip-day-row").content.cloneNode(true);
    this.#list("skip-day-helper").appendChild(node);
  }

  #setDOW(values) {
    const set = new Set(values.map(String));
    this.#qsa('input[data-dow]').forEach(cb => cb.checked = set.has(cb.value));
  }
  #setDOM(prefix, checked) {
    this.#qsa(`input[data-dom="${prefix}"]`).forEach(cb => cb.checked = checked);
  }
  #setMonths(checked) {
    this.#qsa('input[data-month]').forEach(cb => cb.checked = checked);
  }

  #addAdvCalendar(listName) {
    const node = this.#tpl("adv-calendar").content.cloneNode(true);
    this.#list(listName).appendChild(node);
  }

  #addAdvInterval() {
    const node = this.#tpl("adv-interval").content.cloneNode(true);
    node.querySelector('input[name="every_s"]').value = "3600";
    this.#list("adv-intervals").appendChild(node);
  }

  #applyValue(v) {
    let obj;
    try { obj = jsonMaybe(v); } catch { return; }
    if (!obj || typeof obj !== "object") return;

    const spec = obj.spec || {};
    const policy = obj.policy || {};
    const state = obj.state || {};

    this.#qs('input[name="time_zone_name"]').value = spec.time_zone_name || browserTZ();

    this.#qs('input[name="start_at_local"]').value = spec.start_at_local || "";
    this.#qs('input[name="end_at_local"]').value = spec.end_at_local || "";

    // jitter
    const jitterS = Number(spec.jitter_seconds || 0);
    this.#qs('input[name="jitter_value"]').value = String(jitterS);
    this.#qs('select[name="jitter_unit"]').value = "seconds";

    // policy
    this.#qs('select[name="overlap"]').value = policy.overlap || "";
    this.#qs('input[name="catchup_value"]').value = String(Number(policy.catchup_window_seconds || 0));
    this.#qs('select[name="catchup_unit"]').value = "seconds";

    // state
    this.#qs('input[name="paused"]').checked = !!state.paused;
    this.#qs('input[name="limited_actions"]').checked = !!state.limited_actions;
    this.#qs('input[name="remaining_actions"]').value = String(state.remaining_actions ?? 0);

    // clear lists
    this.#list("times").innerHTML = "";
    this.#list("cron").innerHTML = "";
    this.#list("intervals").innerHTML = "";
    this.#list("adv-calendars").innerHTML = "";
    this.#list("adv-intervals").innerHTML = "";
    this.#list("adv-cron").innerHTML = "";
    this.#list("skip-day-helper").innerHTML = "";
    this.#list("skip-calendars").innerHTML = "";

    // infer mode
    const hasCron = (spec.cron_expressions || []).length > 0;
    const hasInt = (spec.intervals || []).length > 0;
    const hasCal = (spec.calendars || []).length > 0;
    const mode =
      (hasCal && !hasInt && !hasCron) ? "calendar" :
      (hasInt && !hasCal && !hasCron) ? "interval" :
      (hasCron && !hasCal && !hasInt) ? "cron" :
      "advanced";

    this.#qs('select[name="mode"]').value = mode;
    this.#updatePanels();

    // cron
    const cronTarget = mode === "cron" ? "cron" : "adv-cron";
    for (const c of (spec.cron_expressions || [])) {
      this.#addCronRow(cronTarget);
      this.#list(cronTarget).lastElementChild.querySelector('input[name="cron_expr"]').value = c;
    }

    // intervals
    if (mode === "interval") {
      for (const it of (spec.intervals || [])) {
        this.#addIntervalRow("intervals");
        const row = this.#list("intervals").lastElementChild;
        // stored in seconds; load as seconds into unit selector for simplicity
        row.querySelector('input[name="every_val"]').value = String(Math.max(1, Number(it.every_seconds || 60)));
        row.querySelector('select[name="every_unit"]').value = "seconds";
        const off = Number(it.offset_seconds || 0);
        row.querySelector('input[name="offset_enabled"]').checked = off !== 0;
        row.querySelector("[data-offset]").hidden = off === 0;
        row.querySelector('input[name="offset_val"]').value = String(off);
        row.querySelector('select[name="offset_unit"]').value = "seconds";
      }
    } else if (mode === "advanced") {
      for (const it of (spec.intervals || [])) {
        this.#addAdvInterval();
        const row = this.#list("adv-intervals").lastElementChild;
        row.querySelector('input[name="every_s"]').value = String(it.every_seconds || 60);
        row.querySelector('input[name="offset_s"]').value = String(it.offset_seconds || 0);
      }
    }

    // calendars
    if (mode === "calendar") {
      const times = [];
      for (const cal of (spec.calendars || [])) {
        const hh = cal.hour?.[0]?.start;
        const mm = cal.minute?.[0]?.start;
        const ss = cal.second?.[0]?.start ?? 0;
        if (Number.isInteger(hh) && Number.isInteger(mm)) times.push({ hh, mm, ss });
      }
      const uniq = new Map();
      for (const t of times) uniq.set(`${t.hh}:${t.mm}:${t.ss}`, t);
      for (const t of uniq.values()) {
        const hm = String(t.hh).padStart(2, "0") + ":" + String(t.mm).padStart(2, "0");
        this.#addTimeRow(hm, t.ss);
      }
    } else if (mode === "advanced") {
      for (const cal of (spec.calendars || [])) {
        this.#addAdvCalendar("adv-calendars");
        const el = this.#list("adv-calendars").lastElementChild;
        el.querySelector('input[name="adv_comment"]').value = cal.comment || "";
        for (const field of ["second","minute","hour","day_of_month","month","day_of_week","year"]) {
          const holder = el.querySelector(`[data-adv-field="${field}"]`);
          holder.innerHTML = "";
          for (const r of (cal[field] || [])) {
            const rr = this.#tpl("range-row").content.cloneNode(true);
            rr.querySelector('input[name="r_start"]').value = String(r.start);
            rr.querySelector('input[name="r_end"]').value = String(r.end ?? r.start);
            rr.querySelector('input[name="r_step"]').value = String(r.step ?? 1);
            holder.appendChild(rr);
          }
        }
      }
    }

    // skip calendars
    for (const cal of (spec.skip || [])) {
      this.#addAdvCalendar("skip-calendars");
      const el = this.#list("skip-calendars").lastElementChild;
      el.querySelector('input[name="adv_comment"]').value = cal.comment || "";
      for (const field of ["second","minute","hour","day_of_month","month","day_of_week","year"]) {
        const holder = el.querySelector(`[data-adv-field="${field}"]`);
        holder.innerHTML = "";
        for (const r of (cal[field] || [])) {
          const rr = this.#tpl("range-row").content.cloneNode(true);
          rr.querySelector('input[name="r_start"]').value = String(r.start);
          rr.querySelector('input[name="r_end"]').value = String(r.end ?? r.start);
          rr.querySelector('input[name="r_step"]').value = String(r.step ?? 1);
          holder.appendChild(rr);
        }
      }
    }

    this.#ensureMinimumRows();
    this.#sync();
  }

  #sync() {
    this.#internals.setValidity({});
    const required = this.hasAttribute("required");

    try {
      const mode = this.#qs('select[name="mode"]').value;
      const spec = this.#buildSpec(mode);
      const policy = this.#buildPolicy();
      const state = this.#buildState();

      const hasAny = (spec.calendars?.length ?? 0) || (spec.intervals?.length ?? 0) || (spec.cron_expressions?.length ?? 0);
      if (required && !hasAny) this.#internals.setValidity({ valueMissing: true }, "Please configure at least one schedule time.");

      const ra = state.remaining_actions ?? 0;
      const la = !!state.limited_actions;
      if (ra !== 0 && !la) this.#internals.setValidity({ customError: true }, "If remaining actions is non-zero, enable Limit actions.");
      if (ra === 0 && la) this.#internals.setValidity({ customError: true }, "If remaining actions is 0, disable Limit actions.");

      this.#model = { spec, policy, state };
      this.#internals.setFormValue(JSON.stringify(this.#model));

      this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid schedule";
      this.#internals.setValidity({ customError: true }, msg);
      this.#internals.setFormValue("");
    }
  }

  #buildSpec(mode) {
    const tz = (this.#qs('input[name="time_zone_name"]').value || "").trim() || browserTZ();
    const spec = {
      time_zone_name: tz,
      ...(this.#qs('input[name="start_at_local"]').value ? { start_at_local: this.#qs('input[name="start_at_local"]').value } : {}),
      ...(this.#qs('input[name="end_at_local"]').value ? { end_at_local: this.#qs('input[name="end_at_local"]').value } : {}),
    };

    // jitter seconds
    const jitterVal = Number(this.#qs('input[name="jitter_value"]').value || 0);
    const jitterUnit = this.#qs('select[name="jitter_unit"]').value;
    const jitterS = Math.max(0, Math.floor(jitterVal * unitToSeconds[jitterUnit]));
    if (jitterS) spec.jitter_seconds = jitterS;

    // skip calendars: (1) day helper -> skip calendar objects, (2) explicit skip calendars
    const skip = [];

    for (const i of this.#qsa('[data-list="skip-day-helper"] input[name="skip_day"]')) {
      if (!i.value) continue;
      const cal = dayToSkipCalendar(i.value);
      if (cal) skip.push(cal);
    }

    // skip calendar rules (adv calendars)
    for (const calEl of this.#qsa('[data-list="skip-calendars"] [data-kind="adv-calendar"]')) {
      const out = {};
      const comment = calEl.querySelector('input[name="adv_comment"]').value.trim();
      if (comment) out.comment = comment;
      for (const field of ["second","minute","hour","day_of_month","month","day_of_week","year"]) {
        const ranges = Array.from(calEl.querySelectorAll(`[data-adv-field="${field}"] [data-kind="range-row"]`))
          .map(r => {
            const start = Number(r.querySelector('input[name="r_start"]').value);
            const end = Number(r.querySelector('input[name="r_end"]').value);
            const step = Number(r.querySelector('input[name="r_step"]').value || 1);
            if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step)) return null;
            return { start: Math.floor(start), end: Math.floor(end), step: Math.max(1, Math.floor(step)) };
          })
          .filter(Boolean);
        if (ranges.length) out[field] = ranges;
      }
      if (Object.keys(out).length) skip.push(out);
    }
    if (skip.length) spec.skip = skip;

    if (mode === "cron") {
      const cron = this.#qsa('[data-list="cron"] input[name="cron_expr"]').map(i => i.value.trim()).filter(Boolean);
      if (cron.length) spec.cron_expressions = cron;
      return spec;
    }

    if (mode === "interval") {
      const intervals = this.#qsa('[data-list="intervals"] [data-kind="interval-row"]').map(row => {
        const ev = Number(row.querySelector('input[name="every_val"]').value);
        const eu = row.querySelector('select[name="every_unit"]').value;
        if (!Number.isFinite(ev) || ev < 1) throw new Error("Interval every must be >= 1");
        const everyS = Math.floor(ev * unitToSeconds[eu]);

        let offsetS = 0;
        const enabled = row.querySelector('input[name="offset_enabled"]').checked;
        if (enabled) {
          const ov = Number(row.querySelector('input[name="offset_val"]').value);
          const ou = row.querySelector('select[name="offset_unit"]').value;
          if (!Number.isFinite(ov) || ov < 0) throw new Error("Offset must be >= 0");
          offsetS = Math.floor(ov * unitToSeconds[ou]);
        }
        return { every_seconds: everyS, offset_seconds: offsetS };
      });
      if (intervals.length) spec.intervals = intervals;
      return spec;
    }

    if (mode === "calendar") {
      const pattern = this.#qs('select[name="cal_pattern"]').value;

      const times = this.#qsa('[data-list="times"] [data-kind="time-row"]').map(row => {
        const hm = row.querySelector('input[name="time_hm"]').value;
        const s = Number(row.querySelector('input[name="time_s"]').value || 0);
        const parsed = parseHHMM(hm);
        if (!parsed) return null;
        if (!Number.isFinite(s) || s < 0 || s > 59) throw new Error("Seconds must be 0-59");
        return { ...parsed, ss: Math.floor(s) };
      }).filter(Boolean);

      if (!times.length) throw new Error("Please add at least one time.");

      const base = {};
      if (pattern === "weekly") {
        const dows = this.#qsa('input[data-dow]:checked').map(cb => Number(cb.value));
        if (!dows.length) throw new Error("Select at least one day of week.");
        base.day_of_week = singletonRanges(dows);
      } else if (pattern === "monthly") {
        const dom = this.#qsa('input[data-dom="dom"]:checked').map(cb => Number(cb.value));
        if (!dom.length) throw new Error("Select at least one day of month.");
        base.day_of_month = singletonRanges(dom);
      } else if (pattern === "yearly") {
        const months = this.#qsa('input[data-month]:checked').map(cb => Number(cb.value));
        const dom = this.#qsa('input[data-dom="domy"]:checked').map(cb => Number(cb.value));
        if (!months.length) throw new Error("Select at least one month.");
        if (!dom.length) throw new Error("Select at least one day of month.");
        base.month = singletonRanges(months);
        base.day_of_month = singletonRanges(dom);
      }

      // One calendar per time (avoid cross-products of hour/minute selections)
      spec.calendars = times.map(t => ({
        ...base,
        hour: singletonRanges([t.hh]),
        minute: singletonRanges([t.mm]),
        second: singletonRanges([t.ss]),
      }));
      return spec;
    }

    // advanced
    if (mode === "advanced") {
      const cron = this.#qsa('[data-list="adv-cron"] input[name="cron_expr"]').map(i => i.value.trim()).filter(Boolean);
      if (cron.length) spec.cron_expressions = cron;

      const intervals = this.#qsa('[data-list="adv-intervals"] [data-kind="adv-interval"]').map(row => {
        const everyS = Number(row.querySelector('input[name="every_s"]').value);
        const offsetS = Number(row.querySelector('input[name="offset_s"]').value || 0);
        if (!Number.isFinite(everyS) || everyS < 1) throw new Error("Advanced interval every_seconds must be >= 1");
        if (!Number.isFinite(offsetS) || offsetS < 0) throw new Error("Advanced interval offset_seconds must be >= 0");
        return { every_seconds: Math.floor(everyS), offset_seconds: Math.floor(offsetS) };
      });
      if (intervals.length) spec.intervals = intervals;

      const calendars = this.#qsa('[data-list="adv-calendars"] [data-kind="adv-calendar"]').map(calEl => {
        const out = {};
        const comment = calEl.querySelector('input[name="adv_comment"]').value.trim();
        if (comment) out.comment = comment;

        for (const field of ["second","minute","hour","day_of_month","month","day_of_week","year"]) {
          const ranges = Array.from(calEl.querySelectorAll(`[data-adv-field="${field}"] [data-kind="range-row"]`))
            .map(r => {
              const start = Number(r.querySelector('input[name="r_start"]').value);
              const end = Number(r.querySelector('input[name="r_end"]').value);
              const step = Number(r.querySelector('input[name="r_step"]').value || 1);
              if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step)) return null;
              return { start: Math.floor(start), end: Math.floor(end), step: Math.max(1, Math.floor(step)) };
            })
            .filter(Boolean);
          if (ranges.length) out[field] = ranges;
        }
        return out;
      }).filter(c => Object.keys(c).length > 0);

      if (calendars.length) spec.calendars = calendars;
      return spec;
    }

    return spec;
  }

  #buildPolicy() {
    const overlap = (this.#qs('select[name="overlap"]').value || "").trim();
    const val = Number(this.#qs('input[name="catchup_value"]').value || 0);
    const unit = this.#qs('select[name="catchup_unit"]').value;
    const seconds = Math.max(0, Math.floor(val * unitToSeconds[unit]));

    const out = {};
    if (overlap) out.overlap = overlap;
    if (seconds) out.catchup_window_seconds = seconds;
    return out;
  }

  #buildState() {
    const paused = this.#qs('input[name="paused"]').checked;
    const limited = this.#qs('input[name="limited_actions"]').checked;
    const remaining = Number(this.#qs('input[name="remaining_actions"]').value || 0);
    if (!Number.isFinite(remaining) || remaining < 0 || Math.floor(remaining) !== remaining) {
      throw new Error("Remaining actions must be an integer >= 0");
    }
    return {
      ...(paused ? { paused: true } : {}),
      limited_actions: !!limited,
      remaining_actions: Math.floor(remaining),
    };
  }
}

customElements.define("temporal-schedule-input", TemporalScheduleInput);