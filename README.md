# Conversion Model Lab

`conversion_model_lab.html` is a single HTML file that evaluates a conversion model from a CSV of test-set predictions. To use it, open the file in Chrome, Safari or Edge, drop the CSV on it, confirm the column mapping, and the analysis appears.

- **Privacy:** data is processed inside the browser tab by DuckDB-WASM. Nothing is uploaded anywhere.
- **Network:** the first load needs internet access to fetch two pinned libraries from jsDelivr: Plotly 2.35.2 and DuckDB-WASM 1.29.0. If you're offline the app cannot start, and charts degrade to a message if Plotly alone is unavailable.
- **Previous version:** the prototype is kept unchanged as `model_performance.html`.

## Layout

| Tab | Question it answers |
|---|---|
| Executive Report | Is the model ready for a controlled pilot? Gives a readiness status built from 10 transparent criteria, key findings with "Why this conclusion?", the business opportunity, limitations, and the next steps. It can be exported as a self-contained HTML report or as JSON. |
| Model Performance | How well does the model rank converters? It offers four granularities (overall, daily, weekly, monthly) and three evaluation grains (client-date rows, unique clients, client episodes). It also has the threshold / top-X playground and probability calibration. |
| Targeting Simulator | How do reach and historical conversion capture change when the model replaces today's targeting? It replays the contact schedule, compares strategies at matched budgets with deduplicated purchase counting, and includes the likelihood tiers (Break Points) and class rosters. |
| Segment Diagnostics | Where is the model wrong? It covers "Where it's wrong" (error trees, findings, heatmap, FN/FP browsers), automatically discovered segments, the feature explorer, and the timing of misses. |
| Data & Evaluation Validity | Does the data support the conclusions? It covers schema and mapping, data integrity, evaluation-validity checks ("Not assessed" is never shown as "passed"), metric methodology and runnable self-checks. |

**Several prediction files.** Choose or drop several files on the upload screen, or add more later with **+ Add files…** in the file switcher. One file is analysed at a time. The dark chip at the left of the context bar always shows the active file (e.g. "2 of 3"); click it to switch. Switching rebuilds every tab from the selected file: about 15 s for an 850k-row file, a couple of seconds for small ones. Only the active file is held in memory; the others are read from disk when selected. You confirm the column mapping once, and files with identical columns reuse it. A file with different columns asks for confirmation the first time you select it, and you can cancel back to the current file. Each file keeps its own evaluation settings, filters and tab choices, restored when you switch back.

The global evaluation settings are reached from the top bar and apply to every tab: window, split, model version, outcome horizon and label maturity.

**Filters** (the button at the left of the context bar) narrow every tab by feature values: pick values for categorical features or a min/max range for numeric ones. A live count shows how many rows, clients and positives match before you apply. Active filters appear as removable chips. Each filter tests a client-date row's own value.

Controls inside a tab, such as thresholds, simulator strategies or explorer bins, change only that tab.

The Targeting Simulator has a **How this works** button (top right). It opens a step-by-step guide for the active sub-tab — Campaign comparison, Likelihood tiers or Class rosters — written for non-technical readers, with illustrations and a "what this means for you" note on each step that uses your current settings and results.

## Editing

The HTML is built from `src/`, so edit the sources and rebuild:

```
python3 build.py
```

- `src/styles.css` — design system (light and dark mode, reduced motion and reduced transparency).
- `src/worker.js` — analytical engine (Web Worker). Every ranking metric, period metric, segment metric, calibration fit, the campaign simulator and the Break Points search live here, in one implementation.
- `src/app/*.js` — app modules, concatenated in file-name order. They cover utilities and components, state / DuckDB / engine client, data loading and validation, the shell, the multi-file workspace (`15_workspace.js`), feature filters (`35_filters.js`), one module per tab, and the simulator guides (`55_guide.js`).

## Conventions worth knowing

- **Ranking ties:** records are sorted by score, then by a fixed hash of (client, date). Top-X audiences are therefore exact (`ceil(X × N)`). AUC and PR-AUC treat ties as a single threshold.
- **Unique clients:** each client's *first* eligible prediction date in the window (or period) is its index record, and its own label is the outcome. The maximum score is never used.
- **Campaign counting:** each purchase is counted once per strategy, however many contacts or overlapping 14-day labels point at it. Contacts and unique clients are reported separately.
- **Intervals:** rates use client-clustered Wilson intervals. Pooled AUC and PR-AUC use a client-block bootstrap.
- **Calibration:** computed only for a mapped `PREDICTED_PROBABILITY`, or for a score you explicitly declare to be a probability.
