# Sidebar panel UI overhaul: design

Date: 2026-11-07. Status: approved in conversation through mock-ups; this document is the written design. It builds on the plugin spec (`2026-11-03-azure-devops-plugin-design.md`) and changes only how the sidebar presents what the plugin already does.

## 1. Why

The author ran the plugin against their real organisation for the first time. Everything works: Azure CLI sign-in, loading, actions. But the sidebar is hard to read and much less calm than the mock-ups from the original planning:

- **PRs and Pipelines** are one long list across every project and repository. Pipelines named "Build Pipeline" appear several times with no way to tell which project each belongs to. Release sets carry a comma-joined list of every source branch, several chips per row, and the same three buttons even when nothing is left to approve.
- **Work** shows each story as a tall card that is mostly a full-width "Move to" box and a "Details" button, so about three items fit a screen. Tasks are not shown with their story; they land in an "Other" group. There is no way to collapse or expand everything, and no swimlane view, which is how many teams read an Azure DevOps board.
- **Wiki** works well, and its wiki dropdown and search are good. But every tree row has the same page icon, so a parent page with 17 sub-pages looks like a single page. An open page spends five rows on its header. At sidebar width, tables break words mid-way, and Mermaid diagrams show as source code.
- **Stage chips** on pipeline cards render as tiny empty grey bars. That is a bug.

The root cause: the planning mock-ups were free-form HTML, while the sidebar can only use Orca's panel component catalogue. The build used that catalogue literally (one Card per item, one Select per card) rather than designing for it.

## 2. Goals

1. **At a glance, you can see which project (and, when it matters, which repository) every pull request and pipeline run belongs to.**
2. **Calmer, denser cards** that keep the card look the author likes, show only what helps you decide, and offer an action only when it applies.
3. **Work reads like a board:** tasks under their story, a Columns view and a Lanes view (the board's own swimlanes), and collapse or expand all.
4. **Wiki pages are pleasant to browse and read,** including drawn Mermaid diagrams and readable tables.
5. **The same visual language across all four tabs:** toolbar layout, group headers, card anatomy, chips and empty states.

## 3. Non-goals

- No new Azure DevOps features. Behaviour, data, settings, polling, notifications and the worker protocol stay as they are, except where this document needs a small addition (for example, reading parent stories). Each such addition is named in §6.
- No changes to the full-width board tab or run tab beyond what §5 says, and none to the in-panel PR review view (unless it shares a component this work restyles).
- No multi-org layout change. The panel stays scoped to the organisation chosen at the top.

## 4. Anti-goals

The overhaul fails, even if it technically works, if:

- it hard-codes one company's setup (project, repository, lane, column or branch names). Grouping and lanes come from Azure DevOps data;
- it hides information people act on (a failing build, a waiting approval, who it waits for) to look clean;
- the panel breaks Orca's limits on a large organisation (5,000 nodes, 1 KiB labels, Tree depth 16, 256 KiB posts) or becomes slow;
- it loses state people set (the open or closed groups, the chosen view, the project filter) every time the panel reloads;
- it ships company data. The repository is public: docs, fixtures and screenshots use generic names (contoso, fabrikam).

## 5. The design

The approved mock-ups are local, git-ignored files under `.superpowers/brainstorm/` in the author's repository. They contain private sample data and must not be committed. This section is the authoritative description. Items marked **(author)** were decided by the author; the rest are the designer's calls, which the builder may refine without changing intent.

### 5.1 Shared language

- **Toolbar** (one row at the top of each tab): scope pickers on the left, the tab's existing filter tabs, then icon buttons on the right: **Collapse all**, **Expand all**, **Refresh**, and (Work only) **Open board**. The current "Updated 22s ago" line stays, but shares that row or sits under it in muted text. It never takes a row of its own together with a lone button.
- **Group headers** are collapsible sections with a name, a muted count, and an optional muted right-hand hint ("1 needs you", "build running").
- **Card anatomy:**
  - a bold title (at most two lines);
  - one muted meta line;
  - then the rows that matter;
  - then at most one row of small buttons, with the primary action first.

  No full-width controls inside cards.
- **Chips:** one status chip per thing, with tone carrying meaning: success, warning, danger, neutral or accent. A merged pull request shows only "merged", because approvals no longer matter. Otherwise show the worst of build and policy status, plus the reviewer or group it waits on.
- **Open and closed state persists:** Collapse all, Expand all and each group's state survive panel reloads and tab switches, per organisation.

### 5.2 PRs tab (author)

- **Grouping:** project first, as collapsible groups.
  - **Most projects have one repository:** the group stays flat, and its header names the repository ("Fabrikam · fabrikam-web").
  - **When the shown items of a project come from more than one repository:** the project gets one sub-group per repository.
  - **A release set whose pull requests span repositories:** it goes in an "Across repos" sub-group at the top of that project, and each row carries a repository chip.
  - **A release set whose pull requests span projects** (sets are joined by shared work items across the organisation): it goes in one **Across projects** group at the top of the list, never copied under each project. Each row carries a `project / repo` chip. The project picker shows the set when any of its pull requests is in the chosen project.
- **Release sets stay one card,** as built.
- **Pickers:** a **project picker** ("All projects" by default) filters the list. When the chosen project has more than one repository, a **repository picker** appears beside it.
- **Card:**
  - the title;
  - a meta line with the repository (only when not already in the header) and the source branch. Several branches that share a prefix collapse to one pattern ending in `*`; otherwise "3 branches";
  - one row per pull request: `!id → target` and one status chip. Merged rows past the first two fold into "+ N merged · show";
  - buttons: **Share…** first, then **Approve** and **Auto-complete**, each shown only when some pull request in the set still needs it.
- **Mine | To review switch:** today the tab shows your release sets, then a collapsed "To review (N)" section with "Reviewed by you" inside it. A two-way switch, **Mine | To review · N**, replaces that collapsed section; the data is the same, and "Reviewed by you" stays inside To review.
  - There is no Completed view: the worker drops fully merged sets, so it would need new data, which §3 rules out.
  - Project grouping applies to To review too. Its rows stay compact rows (not set cards) under the same project and repository headers.
- **The auto-complete settings sentence** moves out of the list, into the settings button's tooltip or a one-line muted note.

### 5.3 Pipelines tab (author)

- **Grouping and pickers:** the same rule as PRs. Project first, repository sub-groups only when a project's shown runs come from more than one repository, and the same project and repository pickers. Runs without a repository go under the project without a sub-group.
- **Run card:**
  - the first row: the status chip, the pipeline name, and the age on the right;
  - the meta line: the build number and the branch, or `PR !id`. The person's name is dropped on Mine, because it's you;
  - **stage chips that render properly:** a short row of small chips (name and glyph), fixing the empty grey bars;
  - for a waiting approval, one compact warning line: "Production needs Release Approvers · waiting 4d";
  - buttons: **Share for approval** (only when waiting), **Open run**, and **Watch** (the bell).
- **Kept as built:** the filter tabs (Mine, Running, Needs me, Failed).

### 5.4 Work tab (author)

- **Toolbar:** the board label, a **Columns | Lanes** switch, then Collapse all, Expand all, Refresh and Open board. The board label is today's backlog-level badge with the team added, for example "Platform · Stories". It is a label, not a picker: the board still comes from the organisation's settings.
- **Columns view** (the default; the choice is remembered per board): one collapsible group per board column, in board order, each with a count.
- **Lanes view (author: the board's own swimlanes):** one collapsible group per swimlane, in board order. Inside each lane, one collapsible sub-group per column holds that lane's items. On a board with no swimlanes, the view matches Columns, with a one-line note.
- **Item card** (two lines):
  - a type stripe or icon (story, bug, and so on, from the item's type);
  - the title;
  - a meta line with `#id`, the environment chips (dev, staging…) as built, and on the right a **Tasks n/m** toggle and a compact **Move** control.

  Pressing the card's title opens the existing details. The full-width "Move to" box and the "Details" button go. About eight items should fit a typical sidebar screen.
- **Tasks under their story (author):**
  - Child tasks show indented under their parent item, each with its id, title, state and, when it isn't you, the assignee's name. The parent is usually a story, but it may be any type.
  - This includes every child task of the parent, whoever it's assigned to and including done ones. The parent shows "Tasks n/m done", and done tasks are drawn muted.
  - The children come from one batched read using the child ids already in the parent's relations. Past 20 children, a story shows "+ N more".
  - A task whose parent is not in your list shows under that parent, drawn dimmed as a header, in the parent's board column (and lane). When the parent isn't on the board at all, it goes in **Not on this board**.
  - Only tasks with no parent go in a final **No parent** group.
- **"Other" becomes "Not on this board":** this group holds the items that move by state, not by column: Features and Epics assigned to you, bugs the board doesn't show, and board-type items with no column. It is grouped by type, with each item's tasks nested as above. Nothing that's there today disappears.
- **Collapse all and expand all (author):** they act on every group and lane, and each story's task list follows them too.

### 5.5 Wiki tab (author on the goals; designer on the specifics)

- **Kept:** the wiki dropdown and the search box (the author likes them).
- **Toolbar row:** search fills the row. Refresh, Collapse all and Expand all are icon buttons at its end, and the lone refresh row goes.
- **Tree:**
  - a folder icon for pages with sub-pages. Their sub-page count shows as the item description once that level has loaded, never by reading ahead;
  - a page icon for leaves;
  - the open page selected, with its ancestors expanded;
  - expansion is remembered.
- **A page in the sidebar:**
  - a breadcrumb back link (the parent path);
  - the title;
  - one row of actions: **Open in tab** (primary), **Edit in Orca**, **Open in Azure DevOps**, and Refresh as an icon.
- **Content in the sidebar** stays a quick read, except:
  - a Mermaid block (both the `::: mermaid` and fenced forms) becomes a small "Diagram · <kind>" card with an **Open in tab** button;
  - a table wider than the sidebar can show readably becomes a "Table · N columns" card with the header names and **Open in tab**.
- **Open in tab** shows the page full width: Markdown laid out properly, tables readable, Mermaid diagrams drawn, and the page's headings available for navigation. The page stays read-only there; editing stays **Edit in Orca**.

## 6. Constraints the builder must respect

- **Orca's panel catalogue only** (Orca ≥ 1.4.248):
  - Stack, Row, Box (border, radius, background, padding, `scroll`), Grid, Card, ListItem, Collapsible (controlled `open` with `onChange`), Tabs, Toolbar, Select, Button, IconButton, Badge, Text, Link, Tree (per-item `icon` and `description`, controlled `expanded`), Markdown, Table, Callout, RelativeTime, and the rest of the typings in `.orca/types/orca`;
  - icons only from Orca's `IconName` list, which includes `folder`, `file-text`, `book`, `bug`, `expand`, `collapse`, `filter`, `more` and `branch`;
  - `ListItem` with `onPress` cannot contain other controls.
- **The panel's limits:** 5,000 nodes, 1 KiB per label, Tree depth ≤ 16, 256 KiB posts. Test the largest realistic fixture: 30 runs with approvals, 50 pull requests in sets, 150 work items with 300 tasks, and a wiki tree of 2,000 pages. Large groups may fold behind "Show N more" rather than break a limit.
- **Behaviour and conventions from Plans 1–6 stay:**
  - single-sourced copy;
  - per-row state keyed by id, never by list position;
  - mounted tests keep `panel.errors` and `panel.warnings` empty;
  - existing tests change only where this design changes what they pin.
- **Allowed data additions:**
  - reading the parents of tasks that aren't in the list, and the child tasks of listed parents (any assignee, done ones included), each as one batched read on load and never per item, kept within the 256 KiB post budget;
  - the board's swimlanes and each item's lane, already read by the board configuration and work-item loads;
  - persisting view, filter and group state in plugin storage (not in browser-like panel memory alone).
- **Mermaid:** Orca ships a Mermaid renderer for its own Markdown preview. Open in tab should use Orca's own preview of a git-ignored, read-only copy of the page if a spike shows `editor.open` can show one with diagrams drawn. Otherwise use a new full-width custom editor frame like the board and run tabs. That frame may not import npm packages, so it would need a vendored renderer. Choose that only if the spike rules out Orca's preview, and record the size cost.
- **The public repository rule:** no company names, repository names, people or tenant data in code, fixtures, docs or screenshots.

## 7. Left to the builder

- Exact composition, spacing and icon choices within the catalogue; how a "pressable title" is built given the ListItem rule (for example a Link-styled title inside a Card).
- The compact Move control's form (a narrow Select in a Box, or a button that reveals the existing Select).
- Where open, closed, view and filter state lives, and how the "Show N more" cut-offs are chosen.
- The order of work and how the tasks split, provided each tab stays shippable on its own.
- Whether the PRs and Pipelines grouping share one grouping module (they should share the rule).

## 8. Done means

- On PRs and Pipelines you can tell the project of every card without opening it. A project with several repositories shows them as sub-groups, and one with a single repository stays flat.
- On Work every task sits under its parent (or in No parent when it has none), and nothing that showed before is missing. Columns and Lanes both work, and the chosen view and open groups survive a reload. On PRs and Pipelines the project and repository filters survive a reload too.
- On Wiki parent pages look different from leaves, and Open in tab shows a page with its Mermaid diagrams drawn and its tables readable.
- Stage chips render on every run card.
- All existing tests pass (some updated as this design requires). The new behaviour has tests, including the largest fixtures above within Orca's limits, and `orca plugin validate` and `check` are clean.
- Each tab is checked at 360 px in light and dark themes before the work is called done (a live check with the author).
