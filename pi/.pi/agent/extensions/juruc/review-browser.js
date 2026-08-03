export function targetFromComposedPath(path) {
	let explicitCommentControl = false;
	let lineTarget;
	let filePath;
	for (const node of path) {
		const data = node && typeof node === "object" ? node.dataset : undefined;
		if (!data) continue;
		if (typeof data.utilityButton === "string") explicitCommentControl = true;
		if (typeof data.filePath === "string") filePath = data.filePath;
		if (
			!lineTarget &&
			(data.lineType === "change-addition" || data.lineType === "change-deletion")
		) {
			const value = data.line ?? data.columnNumber;
			const line = Number(value);
			if (Number.isSafeInteger(line) && line > 0)
				lineTarget = {
					side: data.lineType === "change-addition" ? "additions" : "deletions",
					line,
				};
		}
	}
	return explicitCommentControl && lineTarget && filePath
		? { filePath, ...lineTarget }
		: undefined;
}

export function singleLineSelection(target) {
	return {
		filePath: target.filePath,
		side: target.side,
		startLine: target.line,
		endLine: target.line,
	};
}

export function isFeedbackSubmitShortcut(event) {
	return event.key === "Enter" && Boolean(event.ctrlKey || event.metaKey) && !event.altKey;
}

export function isReviewDecisionDisabled(kind, state) {
	return Boolean(state.decision) ||
		(kind === "approve" ? state.humanComments.length > 0 : state.humanComments.length === 0);
}

export function reviewCompletion(kind) {
	const label = kind === "approve" ? "Approved" : "Feedback sent";
	return {
		label,
		message: `${label}. Decision recorded; this tab may be closed.`,
	};
}

export async function submitReviewDecision(kind, requestDecision, complete) {
	const payload = await requestDecision(kind);
	complete(payload.state);
	return payload.state;
}

export function savedSidebarVisible(readPreference) {
	try {
		return readPreference() === "visible";
	} catch {
		return false;
	}
}

if (typeof document !== "undefined") {
	const apiBase = document.body.dataset.apiBase;
	const reviewRange = document.body.dataset.reviewRange;
	const composer = document.querySelector("#comment-composer");
	const targetOutput = document.querySelector("#comment-target");
	const textarea = document.querySelector("#comment-body");
	const commentHeading = document.querySelector("#comment-heading");
	const browserStatus = document.querySelector("#browser-status");
	const reviewStatus = document.querySelector("#review-status");
	const saveButton = document.querySelector("#save-comment");
	const saveButtonLabel = document.querySelector("#save-comment-label");
	const cancelButton = document.querySelector("#cancel-comment");
	const sidebarToggle = document.querySelector("#sidebar-toggle");
	const draftKey = `juruc-review-draft:${reviewRange}`;
	const sidebarKey = `juruc-review-sidebar:${reviewRange}`;
	let review;
	let selection;
	let editingCommentId;

	if (document.body.dataset.mode === "auto") {
		const narrow = matchMedia("(max-width: 1199px)");
		const resolveAutoLayout = () => {
			if (document.body.dataset.completed === "true") return;
			const desired = narrow.matches ? "stack" : "split";
			if (document.body.dataset.resolvedMode === desired) return;
			const url = new URL(location.href);
			url.searchParams.set("auto-layout", desired);
			location.replace(url);
		};
		resolveAutoLayout();
		narrow.addEventListener("change", resolveAutoLayout);
	}

	function setSidebarVisible(visible, persist = true) {
		document.body.classList.toggle("sidebar-hidden", !visible);
		sidebarToggle.setAttribute("aria-checked", String(visible));
		sidebarToggle.querySelector(".option-check").textContent = visible ? "✓" : "";
		if (!persist) return;
		try {
			localStorage.setItem(sidebarKey, visible ? "visible" : "hidden");
		} catch {}
	}

	setSidebarVisible(
		savedSidebarVisible(() => localStorage.getItem(sidebarKey)),
		false,
	);
	sidebarToggle.addEventListener("click", () =>
		setSidebarVisible(document.body.classList.contains("sidebar-hidden")),
	);

	async function request(path, options = {}) {
		const response = await fetch(`${apiBase}${path}`, {
			...options,
			headers: options.body ? { "content-type": "application/json" } : undefined,
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
		return payload;
	}

	function setStatus(message, error = false) {
		browserStatus.textContent = message;
		browserStatus.style.color = error ? "#f19a9a" : "";
	}

	function completeReview(state) {
		const completion = reviewCompletion(state.decision.kind);
		review = { ...(review || {}), state };
		document.body.dataset.completed = "true";
		setStatus(completion.message);
		reviewStatus.classList.remove("open");
		reviewStatus.classList.add("completed");
		reviewStatus.title = state.decision.decidedAt;
		reviewStatus.replaceChildren(document.createElement("span"), completion.label);
		document.querySelector("#review-instruction").textContent = "Read-only completion receipt.";
		for (const control of document.querySelectorAll("button, textarea"))
			control.disabled = true;
		for (const link of document.querySelectorAll(
			".layout-control a, .view-options a, .file-sidebar a",
		)) {
			link.removeAttribute("href");
			link.setAttribute("aria-disabled", "true");
		}
		for (const host of document.querySelectorAll("diffs-container"))
			for (
				const control of host.shadowRoot?.querySelectorAll(
					"[data-gutter-utility-slot]",
				) || []
			)
				control.remove();
		selection = undefined;
		editingCommentId = undefined;
		textarea.value = "";
		composer.hidden = true;
		document.querySelector(".view-menu")?.removeAttribute("open");
		highlightSelection();
		try {
			localStorage.removeItem(draftKey);
		} catch {}
	}

	function targetLabel(target) {
		const side = target.side === "additions" ? "new" : "old";
		const lines = target.startLine === target.endLine
			? `L${target.startLine}`
			: `L${target.startLine}–L${target.endLine}`;
		return `${target.filePath} · ${side} ${lines}`;
	}

	function changedLines(target) {
		const file = review.files.find((candidate) => candidate.filePath === target.filePath);
		return new Set(file?.changed[target.side] || []);
	}

	function validRange(target) {
		const lines = changedLines(target);
		for (let line = target.startLine; line <= target.endLine; line += 1)
			if (!lines.has(line)) return false;
		return true;
	}

	function saveDraft() {
		try {
			if (!selection && !textarea.value) localStorage.removeItem(draftKey);
			else
				localStorage.setItem(
					draftKey,
					JSON.stringify({
						target: selection,
						body: textarea.value,
						...(editingCommentId ? { commentId: editingCommentId } : {}),
					}),
				);
		} catch {}
	}

	function setComposerMode(editing) {
		commentHeading.textContent = editing ? "Edit your feedback" : "Your feedback";
		saveButtonLabel.textContent = editing ? "Save changes" : "Save feedback";
	}

	function highlightSelection() {
		for (const host of document.querySelectorAll("diffs-container")) {
			for (const node of host.shadowRoot?.querySelectorAll("[data-selected-line]") || [])
				node.removeAttribute("data-selected-line");
			if (!selection || host.dataset.filePath !== selection.filePath) continue;
			const lineType = selection.side === "additions" ? "change-addition" : "change-deletion";
			for (let line = selection.startLine; line <= selection.endLine; line += 1)
				for (
					const node of host.shadowRoot?.querySelectorAll(
						`[data-line-type="${lineType}"][data-line="${line}"], [data-line-type="${lineType}"][data-column-number="${line}"]`,
					) || []
				)
					node.setAttribute("data-selected-line", "");
		}
	}

	function showSelection(focus = true) {
		composer.hidden = !selection;
		if (!selection) return;
		targetOutput.textContent = targetLabel(selection);
		highlightSelection();
		saveDraft();
		if (focus) textarea.focus({ preventScroll: true });
	}

	function selectLine(target, extend) {
		if (editingCommentId) {
			setStatus("Save or cancel the open edit before starting another comment.", true);
			textarea.focus();
			return;
		}
		if (
			extend &&
			selection &&
			(selection.filePath !== target.filePath || selection.side !== target.side)
		) {
			setStatus("A range must stay on the same file and diff side.", true);
			return;
		}
		const next = extend && selection
			? {
					...selection,
					startLine: Math.min(selection.startLine, target.line),
					endLine: Math.max(selection.endLine, target.line),
				}
			: singleLineSelection(target);
		if (!validRange(next)) {
			setStatus("The selected range must contain only contiguous changed lines.", true);
			return;
		}
		selection = next;
		setStatus("Draft is local until you save it.");
		showSelection();
	}

	if (document.body.dataset.completed !== "true")
		for (const host of document.querySelectorAll("diffs-container"))
			for (
				const line of host.shadowRoot?.querySelectorAll(
					'[data-gutter] [data-column-number][data-line-type="change-addition"], [data-gutter] [data-column-number][data-line-type="change-deletion"]',
				) || []
			) {
				const side = line.dataset.lineType === "change-addition" ? "new" : "old";
				const utility = document.createElement("div");
				const button = document.createElement("button");
				utility.dataset.gutterUtilitySlot = "";
				button.dataset.utilityButton = "";
				button.type = "button";
				button.textContent = "+";
				button.setAttribute(
					"aria-label",
					`Comment on ${host.dataset.filePath}, ${side} line ${line.dataset.columnNumber}`,
				);
				button.title = "Add review comment";
				utility.append(button);
				line.append(utility);
			}

	document.addEventListener("click", async (event) => {
		if (document.body.dataset.completed === "true") return;
		const element = event.target instanceof Element ? event.target : undefined;
		const editButton = element?.closest(".edit-comment");
		if (editButton) {
			const comment = review?.state.humanComments.find(
				(candidate) => candidate.id === editButton.dataset.commentId,
			);
			if (!comment) {
				setStatus("Saved feedback is still loading.", true);
				return;
			}
			if (selection) {
				if (editingCommentId === comment.id) textarea.focus();
				else setStatus("Save or cancel the open draft before editing saved feedback.", true);
				return;
			}
			editingCommentId = comment.id;
			selection = {
				filePath: comment.filePath,
				side: comment.side,
				startLine: comment.startLine,
				endLine: comment.endLine,
			};
			textarea.value = comment.body;
			setComposerMode(true);
			setStatus("Editing saved feedback. Its target stays fixed.");
			showSelection();
			return;
		}
		const deleteButton = element?.closest(".delete-comment");
		if (deleteButton) {
			if (!confirm("Delete this saved feedback?")) return;
			try {
				await request(`comments/${encodeURIComponent(deleteButton.dataset.commentId)}`, {
					method: "DELETE",
				});
				location.reload();
			} catch (error) {
				setStatus(error.message, true);
			}
			return;
		}
		if (!review) {
			setStatus("Review state is still loading.", true);
			return;
		}
		if (review.state.decision) return;
		const target = targetFromComposedPath(event.composedPath());
		if (target) selectLine(target, event.shiftKey);
	});

	document.addEventListener("keydown", (event) => {
		if (document.body.dataset.completed === "true") return;
		const typing = event.target instanceof Element &&
			(event.target.matches("textarea, input, select") || event.target.isContentEditable);
		if (
			!typing &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			!event.shiftKey
		) {
			const shortcut = event.key.toLowerCase();
			const control = /^[012salwm]$/u.test(shortcut)
				? document.querySelector(`[data-shortcut="${shortcut}"]`)
				: undefined;
			if (control) {
				event.preventDefault();
				control.click();
				return;
			}
		}
	});

	textarea.addEventListener("input", saveDraft);
	cancelButton.addEventListener("click", () => {
		selection = undefined;
		editingCommentId = undefined;
		textarea.value = "";
		setComposerMode(false);
		composer.hidden = true;
		highlightSelection();
		saveDraft();
		setStatus("Draft discarded.");
	});

	saveButton.addEventListener("click", async () => {
		if (!selection) return;
		const body = textarea.value.trim();
		if (!body) {
			setStatus("Write feedback before saving.", true);
			textarea.focus();
			return;
		}
		saveButton.disabled = true;
		try {
			await request(
				editingCommentId ? `comments/${encodeURIComponent(editingCommentId)}` : "comments",
				{
					method: editingCommentId ? "PATCH" : "POST",
					body: JSON.stringify(editingCommentId ? { body } : { ...selection, body }),
				},
			);
			try {
				localStorage.removeItem(draftKey);
			} catch {}
			location.reload();
		} catch (error) {
			setStatus(error.message, true);
			saveButton.disabled = false;
		}
	});
	textarea.addEventListener("keydown", (event) => {
		if (!isFeedbackSubmitShortcut(event)) return;
		event.preventDefault();
		saveButton.click();
	});

	const fileSections = [...document.querySelectorAll(".file-section")];
	const sidebarLinks = [...document.querySelectorAll(".file-sidebar a")];
	let scrollUpdatePending = false;
	function updateActiveFile() {
		scrollUpdatePending = false;
		if (fileSections.length === 0) return;
		const top = document.querySelector(".topbar").getBoundingClientRect().height + 1;
		let active = fileSections[0];
		for (const section of fileSections) {
			if (section.getBoundingClientRect().top > top) break;
			active = section;
		}
		if (innerHeight + scrollY >= document.documentElement.scrollHeight - 1)
			active = fileSections[fileSections.length - 1];
		for (const link of sidebarLinks) {
			if (link.hash === `#${active.id}`) link.setAttribute("aria-current", "location");
			else link.removeAttribute("aria-current");
		}
	}
	function scheduleActiveFileUpdate() {
		if (scrollUpdatePending) return;
		scrollUpdatePending = true;
		requestAnimationFrame(updateActiveFile);
	}
	addEventListener("scroll", scheduleActiveFileUpdate, { passive: true });
	addEventListener("resize", scheduleActiveFileUpdate, { passive: true });
	updateActiveFile();

	for (const button of document.querySelectorAll("[data-decision]"))
		button.addEventListener("click", async () => {
			for (const action of document.querySelectorAll("[data-decision]")) action.disabled = true;
			try {
				await submitReviewDecision(
					button.dataset.decision,
					(kind) => request("decision", {
						method: "POST",
						body: JSON.stringify({ kind }),
					}),
					completeReview,
				);
			} catch (error) {
				setStatus(error.message, true);
				for (const action of document.querySelectorAll("[data-decision]"))
					action.disabled = isReviewDecisionDisabled(action.dataset.decision, review.state);
			}
		});

	request("state")
		.then((payload) => {
			review = payload;
			if (review.state.decision) {
				completeReview(review.state);
				return;
			}
			try {
				const draft = JSON.parse(localStorage.getItem(draftKey) || "null");
				if (draft?.commentId && typeof draft.body === "string") {
					const comment = review.state.humanComments.find(
						(candidate) => candidate.id === draft.commentId,
					);
					if (!comment) {
						localStorage.removeItem(draftKey);
						return;
					}
					editingCommentId = comment.id;
					selection = {
						filePath: comment.filePath,
						side: comment.side,
						startLine: comment.startLine,
						endLine: comment.endLine,
					};
					textarea.value = draft.body;
					setComposerMode(true);
					showSelection(false);
					setStatus("Restored unsaved edits for this feedback.");
					return;
				}
				if (draft?.target && typeof draft.body === "string" && validRange(draft.target)) {
					selection = draft.target;
					textarea.value = draft.body;
					showSelection(false);
					setStatus("Restored an unsaved draft for this patch.");
				}
			} catch {}
		})
		.catch((error) => setStatus(error.message, true));
}
