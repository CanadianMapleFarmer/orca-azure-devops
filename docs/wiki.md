# The Wiki tab

[Back to the README](../README.md)

## The Wiki tab

Open the Azure DevOps panel and choose **Wiki**. It lists the project wikis and the published code wikis in the organisation. With more than one, a **Wiki** picker shows `name · project`, and your choice is remembered for each organisation.

### Reading

- The search row sits above the tree. The search box fills the row, with **Collapse all**, **Expand all** and **Refresh pages** as icon buttons at its end.
- The page tree loads a level at a time: expanding a folder reads its pages. A level shows up to 200 pages, in Azure DevOps's order and then by title. The tree draws up to 1,000 rows and says when it hides some. **Refresh pages** reloads the tree.
- A page with sub-pages has a folder icon, and a page without sub-pages has a page icon. Once a folder's level has loaded, its description counts the pages in it, such as `17 pages`. The tab never reads ahead to count.
- The tab remembers the folders you open, for each organisation and wiki. When it loads, it reopens up to 25 of them, the most recent first. The rest stay closed until you open them. **Collapse all** closes every folder and forgets them. **Expand all** opens the folders in view, reading up to 25 of them at a press. Press it again to go a level deeper. Back from a page, the tree opens the page's parents and selects the page.
- **Search the wiki** needs at least 2 characters. Press Enter to search. It shows up to 25 results, each with a snippet, and says how many pages match. **Clear search** returns to the tree. When the organisation has no wiki search, the tab says so.
- A page is shown as Markdown. Images appear as links, not as pictures, named `Image: <name>`; a reference-style image (`![text][ref]`) keeps its own text. An image at a web address links to that image; an attachment image links to the page in Azure DevOps, where it shows. Links to other wiki pages open that page in Azure DevOps. Only `http`, `https` and `mailto` links are kept, `[[_TOC_]]` is dropped, and a page over 60,000 bytes is cut with a note.
- A page starts with a back link above its title: `‹ All pages`, or the page's parent path such as `‹ Guides / Setup`. Under the title is one row of actions: **Open in tab**, **Edit in Orca** (project wikis only) and **Open in Azure DevOps**, an icon button shown when the page has a web address. **Refresh**, also an icon, is at the right of the row and reloads only that page.
- A Mermaid diagram (a `::: mermaid` block, with or without a space after the colons, or a fenced `mermaid` block) shows as a `Diagram · <kind>` card, such as `Diagram · sequence diagram`, with **Open in tab**. A table with 4 or more columns, or whose widest cells add up to more than 48 characters, shows as a `Table · 5 columns` card with the column names and **Open in tab**. The rest of the page stays Markdown in the sidebar.

A code wiki is a folder of a repository published as a wiki. Its pages are read-only here: the page says so and has no **Edit in Orca**. Edit its files in the repository. Search finds only pages inside the published folder.

### Open in tab

**Open in tab** shows the page full width in Orca's own Markdown view, where tables have room and Mermaid diagrams are drawn. It needs a local workspace in focus. Without one it says `Open a local workspace first; wiki pages open in a tab there.` This hasn't been checked live yet (see [Live checks still pending](development.md#live-checks-still-pending)).

- The tab shows a read-only copy of the page: `<workspace>/.orca-ado/wiki-read/<organisation>/<wiki>/<page path>.md`. It is the `.orca-ado/` folder the board, run tab and drafts use, and its `.gitignore` containing `*` keeps git out. File names are cleaned like a draft's.
- The copy holds the same cleaned Markdown as the sidebar: images are links, only `http`, `https` and `mailto` links are kept, and `[[_TOC_]]` is dropped.
- The copy's first line says it is read-only and where to change the page: **Edit in Orca** on a project wiki, the repository on a code wiki. The file itself is read-only, so a save in the tab fails with Orca's own error and leaves it as it was. The tab still looks editable.
- Both Mermaid forms are drawn, because the copy writes a `::: mermaid` block as a fenced `mermaid` block. Orca's **Table of Contents** button in the tab's header lists the page's headings. If your Orca opens Markdown as source, switch the tab to the rich view to see diagrams.
- Pressing **Open in tab** again reads the page again and rewrites the copy when it changed.
- A copy over 600 KiB is cut at a line and ends with "This page is too long to show here in full. Open it in Azure DevOps to read the rest." Orca opens a larger Markdown file as source, with no diagrams drawn.

### Edit in Orca

**Edit in Orca** on a project wiki page opens the page as a Markdown file in Orca's own editor. It needs a local workspace in focus.

- The file is `<workspace>/.orca-ado/wiki/<organisation>/<wiki>/<page path>.md`. It is a draft. The `.orca-ado/` folder is the one the board and run tabs use, and its `.gitignore` containing `*` keeps git out. File names are cleaned so they are valid on every OS, and a very long one is cut and gets a short hash. A copy of the page as you started it is kept under `.orca-ado/wiki/.base/`.
- Save your changes in the editor, then press **Publish** in the Wiki tab. **Publish**, **Open** and **Discard…** are on the draft's row under **Drafts · N**, above the page tree. On a page, press the back link above its title to reach them. Publish sends what is saved in the file, not edits you haven't saved.
- **Drafts · N** lists your drafts as compact rows. A row has the page's name, a status line, **Publish**, an **Open** icon and a **Discard…** icon. The status line says `Saved changes not published yet.` or `No changes since you opened or published it.`, followed by `Published` and when, once it has been published. That status is as of the last time the list loaded; Publish always reads the saved file. The **Open** icon opens the draft in the editor, and its tooltip shows the file's path under `.orca-ado/`. A row doesn't show the workspace or the file. It shows the wiki's name only when your drafts come from more than one wiki. The group starts open, and the tab remembers if you fold it, for each organisation. You can keep up to 50 drafts across all organisations. A draft stays after you publish it, so you can keep editing. **Discard…** asks first, then deletes the draft's files. It sends nothing to Azure DevOps.
- **Edit in Orca** on a page that has a draft opens that draft again. When you haven't changed it, it is first brought up to the page's current version.
- A draft belongs to the workspace it was made in. When that workspace is gone, discard the draft to edit the page again. A page over 1 MiB can't be edited or published here.

### Publish

**Publish** reads your draft's file, then reads the page again.

- With no saved changes in the draft, it says `Nothing to publish yet` and sends nothing.
- When the page changed in Azure DevOps since you started, it sends nothing and shows the conflict. A change of version with the same text isn't a conflict.
- Otherwise it sends one request with the page's version (its ETag, in `If-Match`), so Azure DevOps refuses it if someone saves in between. A refusal of that kind shows the conflict too.

It never retries and never deletes your draft. When the page was moved or deleted in Azure DevOps, Publish says so and keeps the draft.

### When the page changed

The conflict shows **Their changes** (your starting copy to the current page) and **Your changes** (your starting copy to your draft) as diffs, under the same size rules as review diffs. Choose one:

- **Publish mine…** publishes your draft over their changes, after you confirm. Their changes are lost.
- **Take theirs…** replaces your draft with their version, after you confirm. Your changes are lost.
- **Merge by hand** opens their version in the editor, as a file under `.orca-ado/wiki/.theirs/`. Copy what you need into your draft, save it and press **Publish**. Until you save a change, Publish shows the conflict again and says your draft hasn't changed. **Publish mine** is still there.
