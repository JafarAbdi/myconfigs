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

export function nextNavigationIndex(current, count, delta) {
	if (count < 1 || (delta !== -1 && delta !== 1)) return -1;
	if (current < 0) return delta === 1 ? 0 : -1;
	return Math.max(0, Math.min(count - 1, current + delta));
}

export function compareNavigationPositions(left, right) {
	const leftRect = left.getBoundingClientRect();
	const rightRect = right.getBoundingClientRect();
	return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
}

export function isReviewDecisionDisabled(kind, state) {
	const hasHumanFeedback = state.humanComments.length > 0 || Boolean(state.generalComment);
	return Boolean(state.decision) ||
		(kind === "approve"
			? hasHumanFeedback
			: state.auditFindings.length === 0 && !hasHumanFeedback);
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

if (typeof document !== "undefined") {
	const apiBase = document.body.dataset.apiBase;
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
	const previousHunkButton = document.querySelector("#previous-hunk");
	const nextHunkButton = document.querySelector("#next-hunk");
	const hunkPosition = document.querySelector("#hunk-position");
	const previousAgentCommentButton = document.querySelector("#previous-agent-comment");
	const nextAgentCommentButton = document.querySelector("#next-agent-comment");
	const agentCommentPosition = document.querySelector("#agent-comment-position");
	let review;
	let selection;
	let editingCommentId;
	let editingGeneral = false;

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

	function setSidebarVisible(visible) {
		document.body.classList.toggle("sidebar-hidden", !visible);
		sidebarToggle.setAttribute("aria-checked", String(visible));
		sidebarToggle.querySelector(".option-check").textContent = visible ? "✓" : "";
	}

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
		browserStatus.classList.toggle("error", error);
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
		for (const control of document.querySelectorAll(
			"#comment-composer button, #comment-composer textarea, #add-general-comment, .edit-general-comment, .delete-general-comment, [data-decision]",
		)) control.disabled = true;
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
		editingGeneral = false;
		textarea.value = "";
		composer.hidden = true;
		document.querySelector(".view-menu")?.removeAttribute("open");
		highlightSelection();
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

	function setComposerMode(editing, general = false) {
		commentHeading.textContent = general
			? (editing ? "Edit general feedback" : "General feedback")
			: (editing ? "Edit your comment" : "Your comment");
		saveButtonLabel.textContent = editing ? "Save changes" : "Save comment";
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

	function showComposer(focus = true) {
		composer.hidden = !selection && !editingGeneral;
		if (composer.hidden) return;
		targetOutput.textContent = editingGeneral
			? "Entire candidate"
			: targetLabel(selection);
		highlightSelection();
		if (focus) textarea.focus({ preventScroll: true });
	}

	function openGeneralComment() {
		if (!review) {
			setStatus("Review state is still loading.", true);
			return;
		}
		if (selection || editingCommentId || editingGeneral) {
			setStatus("Save or cancel the open draft before editing general feedback.", true);
			textarea.focus();
			return;
		}
		const comment = review.state.generalComment;
		editingGeneral = true;
		textarea.value = comment?.body ?? "";
		setComposerMode(Boolean(comment), true);
		setStatus(comment ? "Editing general feedback." : "General feedback is local until you save it.");
		showComposer();
	}

	function selectLine(target, extend) {
		if (editingCommentId || editingGeneral) {
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
		showComposer();
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
				button.title = "Add comment";
				utility.append(button);
				line.append(utility);
			}

	document.addEventListener("click", async (event) => {
		if (document.body.dataset.completed === "true") return;
		const element = event.target instanceof Element ? event.target : undefined;
		if (element?.closest("#add-general-comment, .edit-general-comment")) {
			openGeneralComment();
			return;
		}
		if (element?.closest(".delete-general-comment")) {
			if (!confirm("Delete general feedback?")) return;
			try {
				await request("general-comment", { method: "DELETE" });
				location.reload();
			} catch (error) {
				setStatus(error.message, true);
			}
			return;
		}
		const editButton = element?.closest(".edit-comment");
		if (editButton) {
			const comment = review?.state.humanComments.find(
				(candidate) => candidate.id === editButton.dataset.commentId,
			);
			if (!comment) {
				setStatus("Saved comment is still loading.", true);
				return;
			}
			if (selection || editingGeneral) {
				if (!editingGeneral && editingCommentId === comment.id) textarea.focus();
				else setStatus("Save or cancel the open draft before editing a saved comment.", true);
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
			setStatus("Editing a saved comment. Its target stays fixed.");
			showComposer();
			return;
		}
		const deleteButton = element?.closest(".delete-comment");
		if (deleteButton) {
			if (!confirm("Delete this saved comment?")) return;
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
		const typing = event.target instanceof Element &&
			(event.target.matches("textarea, input, select") || event.target.isContentEditable);
		if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
			const shortcut = event.key.toLowerCase();
			if (shortcut === "{" || shortcut === "}") {
				event.preventDefault();
				moveToAgentComment(shortcut === "}" ? 1 : -1);
				return;
			}
			if (!event.shiftKey && (shortcut === "[" || shortcut === "]")) {
				event.preventDefault();
				moveToHunk(shortcut === "]" ? 1 : -1);
				return;
			}
			if (document.body.dataset.completed === "true") return;
			const control = !event.shiftKey && /^[012salwm]$/u.test(shortcut)
				? document.querySelector(`[data-shortcut="${shortcut}"]`)
				: undefined;
			if (control) {
				event.preventDefault();
				control.click();
				return;
			}
		}
	});

	cancelButton.addEventListener("click", () => {
		selection = undefined;
		editingCommentId = undefined;
		editingGeneral = false;
		textarea.value = "";
		setComposerMode(false);
		composer.hidden = true;
		highlightSelection();
		setStatus("Draft discarded.");
	});

	saveButton.addEventListener("click", async () => {
		if (!selection && !editingGeneral) return;
		const body = textarea.value.trim();
		if (!body) {
			setStatus("Write a comment before saving.", true);
			textarea.focus();
			return;
		}
		saveButton.disabled = true;
		try {
			if (editingGeneral) {
				await request("general-comment", {
					method: "PUT",
					body: JSON.stringify({ body }),
				});
			} else {
				await request(
					editingCommentId ? `comments/${encodeURIComponent(editingCommentId)}` : "comments",
					{
						method: editingCommentId ? "PATCH" : "POST",
						body: JSON.stringify(editingCommentId ? { body } : { ...selection, body }),
					},
				);
			}
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
	const hunkCursors = fileSections.flatMap((section) => {
		const host = section.querySelector("diffs-container");
		let targets = [];
		try {
			targets = JSON.parse(section.dataset.hunkTargets || "[]");
		} catch {
			return [];
		}
		return targets.flatMap((target) => {
			if (
				!host ||
				(target.side !== "additions" && target.side !== "deletions") ||
				!Number.isSafeInteger(target.line) ||
				target.line < 1
			) return [];
			const lineType = target.side === "additions"
				? "change-addition"
				: "change-deletion";
			const node = host.shadowRoot?.querySelector(
				`[data-line-type="${lineType}"][data-line="${target.line}"]`,
			) || host.shadowRoot?.querySelector(
				`[data-line-type="${lineType}"][data-column-number="${target.line}"]`,
			);
			return node ? [node] : [];
		});
	});
	const agentCommentCursors = [...document.querySelectorAll("[data-agent-comment]")];

	function createNavigator(
		targets,
		previousButton,
		nextButton,
		position,
		label,
		sortByPosition = false,
	) {
		let currentIndex = -1;
		let suppressScrollSync = false;
		let movement = 0;

		function update() {
			if (!previousButton || !nextButton || !position) return;
			position.textContent = targets.length === 0
				? `No ${label.toLowerCase()}s`
				: currentIndex < 0
					? `${label}s ${targets.length}`
					: `${label} ${currentIndex + 1}/${targets.length}`;
			previousButton.disabled = currentIndex <= 0;
			nextButton.disabled = targets.length === 0 || currentIndex === targets.length - 1;
		}

		function sync() {
			if (targets.length === 0) return;
			if (sortByPosition) targets.sort(compareNavigationPositions);
			const threshold = document.querySelector(".topbar").getBoundingClientRect().bottom + 24;
			let low = 0;
			let high = targets.length - 1;
			let active = -1;
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				if (targets[middle].getBoundingClientRect().top <= threshold) {
					active = middle;
					low = middle + 1;
				} else high = middle - 1;
			}
			currentIndex = active;
			update();
		}

		function move(delta) {
			const next = nextNavigationIndex(currentIndex, targets.length, delta);
			if (next < 0 || next === currentIndex) return;
			currentIndex = next;
			update();
			suppressScrollSync = true;
			const currentMovement = ++movement;
			requestAnimationFrame(() => {
				targets[next].scrollIntoView({ block: "start" });
				const offset = document.querySelector(".topbar").getBoundingClientRect().height + 12;
				scrollBy({ top: -offset });
				setTimeout(() => {
					if (movement === currentMovement) suppressScrollSync = false;
				}, 250);
			});
		}

		update();
		previousButton?.addEventListener("click", () => move(-1));
		nextButton?.addEventListener("click", () => move(1));
		return {
			isScrollSyncSuppressed: () => suppressScrollSync,
			move,
			sync,
		};
	}

	const hunkNavigator = createNavigator(
		hunkCursors,
		previousHunkButton,
		nextHunkButton,
		hunkPosition,
		"Hunk",
	);
	const agentCommentNavigator = createNavigator(
		agentCommentCursors,
		previousAgentCommentButton,
		nextAgentCommentButton,
		agentCommentPosition,
		"Agent",
		true,
	);

	function moveToHunk(delta) {
		hunkNavigator.move(delta);
	}

	function moveToAgentComment(delta) {
		agentCommentNavigator.move(delta);
	}

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
		for (const navigator of [hunkNavigator, agentCommentNavigator])
			if (!navigator.isScrollSyncSuppressed()) navigator.sync();
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
			if (!review) {
				setStatus("Review state is still loading.", true);
				return;
			}
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
			if (review.state.decision) completeReview(review.state);
		})
		.catch((error) => setStatus(error.message, true));
}
