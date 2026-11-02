/**
 * dsh-drawer —— browser client half.
 *
 * 单文件 bundle：宿主以 `window.__ModuleLoader__.load({ id, factory })` 加载。
 * 只 require("react")；不 import 任何 Harness Client 包；模块顶层不触碰 window/document。
 *
 * 注册：
 *   - `sidebar.panellist`        → 侧栏「抽屉」入口行（id=drawer，order=900，排在官方「更多」上面）
 *   - `sidebar.panellist.actions`→ 官方「更多」菜单内容（让「更多」这一行保留为兜底入口）
 *   - `shell.overlay`            → 侧栏右侧的宽抽屉（420px）+ 拖拽浮层
 *   - `main`（keyed=drawer）     → 键盘打开时的整页兜底
 *
 * 数据：
 *   - 面板列表：`ctx.slots.entriesOfSlot("sidebar.panellist")`
 *   - 固定/显示：侧栏注册项注入面里的 `setPinned(id, pinned)`（官方 pin 机制，内存态）
 *   - 来源分组：同源 POST `/api/dsh-drawer/context`（host 半只读 profile 判定 内置 / 我的 / 第三方）
 *   - 编排持久化：localStorage（官方 pin 是内存态，启动时回放）
 *
 * 交互：按住面板拖动 → 拖到抽屉 = 收起（左侧图标消失），拖回侧栏 = 显示。
 */
window.__ModuleLoader__.load({
  id: "dsh-drawer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useRef, useReducer } = react;

    /** 面板 id（同时是 main 的 key 与侧栏入口 id）。 */
    const PANEL_ID = "drawer";
    /** 来源识别接口。 */
    const API_BASE = "/api/dsh-drawer";
    /** 收纳编排的 localStorage key。 */
    const STORAGE_KEY = "dsh-drawer:hidden:v1";
    /** 抽屉默认宽度。 */
    const DEFAULT_WIDTH = 420;
    /** 永远常驻侧栏的内置面板（官方 pin 永远显示 plugins；schedules 一并锁死）。 */
    const BUILTIN_IDS = ["plugins", "schedules"];
    /** 面板拖动阈值（px）。 */
    const DRAG_THRESHOLD = 5;

    // ---------------------------------------------------------------------
    // 状态仓库（模块级，组件通过 useStore 订阅）
    // ---------------------------------------------------------------------
    /** @type {Set<string>} 已收进抽屉的面板 id。 */
    let runtimeCtx = null;

    const state = {
      /** host 半回的 profile 上下文。 */
      context: null,
      /** 插件配置（width / groups）。 */
      hostConfig: {},
      /** 面板（不含 drawer 自己）。 */
      panels: [],
      /** 含 drawer 的面板 id 顺序（用于按侧栏行下标兜底定位）。 */
      navOrder: [],
      /** 侧栏注入面（setPinned 等）。 */
      face: null,
      /** 已收起的面板集合。 */
      hidden: new Set(),
      /** 抽屉是否打开。 */
      drawerOpen: false,
      /** 是否展开「已安装插件」区域。 */
      installedOpen: false,
      /** 当前拖拽状态 {id,label,x,y,source}。 */
      drag: null,
      /** 自定义排序：面板 id 数组（越靠前越靠上）。 */
      order: [],
      /** 拖拽时命中的抽屉行（排序插入位置）。 */
      dropTargetId: null,
      /** 拖拽时命中的侧栏行（排序插入线位置）。 */
      railDrop: null,
      /** 侧栏右边缘（px）。 */
      sidebarRight: 248,
      /** 抽屉宽度。 */
      width: DEFAULT_WIDTH,
    };

    const listeners = new Set();

    /**
     * 通知所有订阅者。
     * @returns {void}
     */
    function emit() {
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (error) {
          console.error("[drawer] listener failed", error);
        }
      }
    }

    /**
     * 合入状态并通知。
     * @param {object} patch 状态片段。
     * @returns {void}
     */
    function set(patch) {
      Object.assign(state, patch);
      emit();
    }

    /**
     * 订阅状态。
     * @param {Function} listener 回调。
     * @returns {() => void} 取消订阅。
     */
    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    /** 组件内订阅状态。 @returns {object} state。 */
    function useStore() {
      const [, bump] = useReducer((n) => n + 1, 0);
      useEffect(() => subscribe(bump), []);
      return state;
    }

    // ---------------------------------------------------------------------
    // 本地持久化
    // ---------------------------------------------------------------------
    /**
     * 读取已收起集合。
     * @returns {Set<string>} 集合。
     */
    function loadHidden() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
      } catch {
        return new Set();
      }
    }

    /** 排序持久化 key。 */
    const ORDER_KEY = "dsh-drawer:order:v1";

    /**
     * 读取自定义排序。
     * @returns {string[]} 面板 id 数组。
     */
    function loadOrder() {
      try {
        const raw = window.localStorage.getItem(ORDER_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
      } catch {
        return [];
      }
    }

    /**
     * 写入自定义排序。
     * @param {string[]} order 面板 id 数组。
     * @returns {void}
     */
    function saveOrder(order) {
      try {
        window.localStorage.setItem(ORDER_KEY, JSON.stringify(order));
      } catch {
        /* localStorage 不可用时保持内存态 */
      }
    }

    /**
     * 写入已收起集合。
     * @param {Set<string>} hidden 集合。
     * @returns {void}
     */
    function saveHidden(hidden) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(hidden)));
      } catch {
        /* localStorage 不可用时保持内存态 */
      }
    }

    // ---------------------------------------------------------------------
    // 面板元数据 / 来源分组
    // ---------------------------------------------------------------------
    /** 包名前缀（用于把包名和面板 id 对齐）。 */
    const NAME_PREFIXES = ["@deepseek-ai/", "dsh-client-ui-", "dsh-experimental-", "dsh-"];

    /**
     * 去掉包名里的厂商前缀。
     * @param {string} name 包名。
     * @returns {string} 归一化名字。
     */
    function normalizeName(name) {
      let value = String(name || "");
      let changed = true;
      while (changed) {
        changed = false;
        for (const prefix of NAME_PREFIXES) {
          if (value.startsWith(prefix)) {
            value = value.slice(prefix.length);
            changed = true;
          }
        }
      }
      return value;
    }

    /**
     * 解析 slot label（可能是 thunk）。
     * @param {string|Function} value label。
     * @param {string} fallback 兜底。
     * @returns {string} 文本。
     */
    function resolveLabel(value, fallback) {
      try {
        const resolved = typeof value === "function" ? value() : value;
        return typeof resolved === "string" && resolved ? resolved : fallback;
      } catch {
        return fallback;
      }
    }

    /**
     * 取面板显示名。
     * @param {object} panel 面板。
     * @returns {string} 名称。
     */
    function labelOf(panel) {
      return resolveLabel(panel.labelSource, panel.id);
    }

    /**
     * 来源标签。
     * @param {string} origin builtin / own / third。
     * @returns {string} 短标签。
     */
    function originLabel(origin) {
      if (origin === "builtin") return "内置";
      if (origin === "own") return "本地";
      return "第三方";
    }

    /**
     * 打开某个面板 id（「已安装插件」区域跳转插件页用）。
     * @param {string} id 面板 id。
     * @returns {void}
     */
    function openPanelId(id) {
      try {
        const layout = runtimeCtx && runtimeCtx.get ? runtimeCtx.get("layout") : null;
        if (layout && typeof layout.selectPanel === "function") layout.selectPanel(id);
      } catch (error) {
        console.warn("[drawer] 打开面板失败", error);
      }
      closeDrawer();
    }

    /**
     * 判定面板来源：builtin / own / third。
     * 依据 host 半回的 profile 数据；取不到时按内置规则兜底。
     * @param {string} id 面板 id。
     * @returns {{origin: string, pkg: string}} 分类。
     */
    function classifyPanel(id) {
      const groups = state.hostConfig && state.hostConfig.groups;
      if (groups && typeof groups === "object" && typeof groups[id] === "string") {
        const origin = groups[id];
        return {
          origin,
          pkg: origin === "builtin" ? "内置面板" : origin === "own" ? "本地插件" : "第三方插件",
        };
      }
      const data = state.context;
      let origin = null;
      let pkgName = null;
      if (data) {
        const row = (data.rows || []).find((item) => item && item.id === id);
        if (row && row.name) {
          pkgName = row.name;
          if (pkgName.startsWith("@deepseek-ai/")) origin = "builtin";
          else {
            const info = (data.packages || []).find((item) => item.name === pkgName);
            origin = info ? info.origin : "third";
          }
        }
        if (!origin) {
          const candidate = (data.packages || []).find((item) => normalizeName(item.name) === id);
          if (candidate) {
            pkgName = candidate.name;
            origin = candidate.origin;
          }
        }
      }
      if (!origin) origin = BUILTIN_IDS.includes(id) ? "builtin" : "third";
      const pkg = pkgName || (origin === "builtin" ? "内置面板" : origin === "own" ? "本地插件" : "第三方插件");
      return { origin, pkg };
    }

    /**
     * 从侧栏注册项的 inject 面里取 setPinned。
     * @param {object} ctx client context。
     * @returns {object|null} inject 面。
     */
    function resolveFace(ctx) {
      let entries = [];
      try {
        entries = ctx.slots.entriesOfSlot("sidebar") || [];
      } catch {
        return null;
      }
      for (const entry of entries) {
        try {
          const face = typeof entry.inject === "function" ? entry.inject() : null;
          if (face && typeof face.setPinned === "function") return face;
        } catch {
          /* 某些注册项的 inject 需要参数，忽略 */
        }
      }
      return null;
    }

    /**
     * 调用官方 pin。
     * @param {string} id 面板 id。
     * @param {boolean} pinned 是否显示在侧栏。
     * @returns {void}
     */
    function applyPin(id, pinned) {
      if (!state.face) return;
      try {
        state.face.setPinned(id, pinned);
      } catch (error) {
        console.warn("[drawer] setPinned 失败", id, error);
      }
    }

    /**
     * 把持久化编排回放到侧栏 pin 上。
     * @returns {void}
     */
    function reconcilePins() {
      if (!state.face) return;
      // 入口行本身永远钉在侧栏（其它插件的「更多」菜单可能会把它取消固定）。
      applyPin(PANEL_ID, true);
      for (const panel of state.panels) {
        if (panel.origin === "builtin") applyPin(panel.id, true);
        else applyPin(panel.id, !state.hidden.has(panel.id));
      }
    }

    /**
     * 收起 / 放回某面板。
     * @param {string} id 面板 id。
     * @param {boolean} hidden 是否收进抽屉。
     * @returns {void}
     */
    function setPanelHidden(id, hidden) {
      if (state.hidden.has(id) === hidden) return;
      const next = new Set(state.hidden);
      if (hidden) next.add(id);
      else next.delete(id);
      state.hidden = next;
      saveHidden(next);
      applyPin(id, !hidden);
      emit();
    }

    // ---------------------------------------------------------------------
    // 抽屉开关 / 面板打开
    // ---------------------------------------------------------------------
    /** 打开抽屉。 @returns {void} */
    function openDrawer() {
      if (!state.drawerOpen) {
        set({ drawerOpen: true });
      }
    }

    /** 关闭抽屉。 @returns {void} */
    function closeDrawer() {
      if (state.drawerOpen) {
        set({ drawerOpen: false });
      }
    }

    /** 切换抽屉。 @returns {void} */
    function toggleDrawer() {
      set({ drawerOpen: !state.drawerOpen });
    }

    /**
     * 打开某个面板。
     * @param {object} panel 面板。
     * @returns {void}
     */
    function openPanel(panel) {
      openPanelId(panel.id);
    }

    // ---------------------------------------------------------------------
    // SVG 图标
    // ---------------------------------------------------------------------
    /** 抽屉图标。 @param {{size?: number}} props props。 @returns {object} node。 */
    function DrawerGlyph({ size = 16 }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("rect", { x: 2.5, y: 4.7, width: 11, height: 8.5, rx: 2.2, stroke: "currentColor", strokeWidth: 1.5 }),
        h("path", { d: "M6.2 8.5h3.6", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" })
      );
    }

    /** 搜索图标。 @param {{size?: number}} props props。 @returns {object} node。 */
    function SearchGlyph({ size = 14 }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("circle", { cx: 7, cy: 7, r: 4.4, stroke: "currentColor", strokeWidth: 1.3 }),
        h("path", { d: "m10.4 10.4 3 3", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
      );
    }

    /** 关闭图标。 @param {{size?: number}} props props。 @returns {object} node。 */
    function CloseGlyph({ size = 16 }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", { d: "m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
      );
    }

    /** 锁图标。 @param {{size?: number, className?: string}} props props。 @returns {object} node。 */
    function LockGlyph({ size = 13, className = "dshdrawer-lock" }) {
      return h(
        "svg",
        { className, width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("rect", { x: 3.2, y: 7, width: 9.6, height: 6.6, rx: 1.8, stroke: "currentColor", strokeWidth: 1.2 }),
        h("path", { d: "M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" })
      );
    }

    /** 拖拽手柄（两点三行）。 @returns {object} node。 */
    function GripDots() {
      return h(
        "svg",
        { width: 8, height: 14, viewBox: "0 0 8 14", fill: "currentColor", "aria-hidden": "true" },
        [0, 1, 2].map((row) =>
          [0, 1].map((col) => h("circle", { key: row + "-" + col, cx: 2 + col * 4, cy: 3 + row * 4, r: 1 }))
        )
      );
    }

    /** 图标渲染错误兜底。 */
    class IconBoundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      render() {
        if (this.state.failed) return h("span", { className: "dshdrawer-dot", "aria-hidden": "true" });
        return this.props.children;
      }
    }

    /**
     * 渲染某面板原插件注册的图标。
     * @param {{panel: object, size?: number}} props props。
     * @returns {object} node。
     */
    function PanelIcon({ panel, size = 16 }) {
      const Component = panel && panel.component;
      if (typeof Component !== "function" && (typeof Component !== "object" || Component === null)) {
        return h("span", { className: "dshdrawer-dot", "aria-hidden": "true" });
      }
      return h(
        "span",
        { className: "dshdrawer-ico", "aria-hidden": "true" },
        h(IconBoundary, null, h(Component, { size, active: false }))
      );
    }

    /** 开关。 @param {{on: boolean, onChange: Function, disabled?: boolean}} props props。 @returns {object} node。 */
    function Switch({ on, onChange, disabled = false }) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": on ? "true" : "false",
        "aria-label": on ? "已固定在侧栏" : "已收进抽屉",
        className: "dshdrawer-switch" + (on ? " is-on" : ""),
        disabled,
        onPointerDown: (event) => {
          event.stopPropagation();
        },
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          onChange(!on);
        },
      }, h("span", { className: "dshdrawer-knob" }));
    }

    // ---------------------------------------------------------------------
    // 组件：侧栏「抽屉」入口行
    // ---------------------------------------------------------------------
    /**
     * 侧栏入口：抽屉图标 + 收起数量角标；点击打开/关闭抽屉。
     * @param {{size?: number}} props slot props。
     * @returns {object} node。
     */
    function Trigger(props) {
      useStore();
      const size = props && props.size ? props.size : 16;
      const ref = useRef(null);

      useEffect(() => {
        /**
         * 用自己所在行按钮的左/右边界反推侧栏列宽：
         * 展开态行宽 220（右 = 列宽-14），折叠态行宽 36（右 = 列宽-10）。
         * @returns {void}
         */
        const measure = () => {
          const element = ref.current;
          if (!element || !element.closest) return;
          const button = element.closest("button");
          if (!button) return;
          const rect = button.getBoundingClientRect();
          if (!rect || !rect.width) return;
          const pad = rect.width > 100 ? 14 : 10;
          const next = Math.round(rect.right + pad);
          if (next && next !== state.sidebarRight) set({ sidebarRight: next });
        };
        measure();
        let observer = null;
        const element = ref.current;
        const button = element && element.closest ? element.closest("button") : null;
        if (button && typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(measure);
          observer.observe(button);
        }
        window.addEventListener("resize", measure);
        const timer = window.setTimeout(measure, 150);
        return () => {
          window.removeEventListener("resize", measure);
          if (observer) observer.disconnect();
          window.clearTimeout(timer);
        };
      }, []);

      const hiddenCount = state.panels.filter((panel) => panel.origin !== "builtin" && state.hidden.has(panel.id)).length;

      return h(
        "span",
        {
          ref,
          className: "dshdrawer-trigger" + (state.drawerOpen ? " is-open" : ""),
        },
        h(DrawerGlyph, { size }),
        hiddenCount > 0 ? h("span", { className: "dshdrawer-badge" }, String(hiddenCount)) : null
      );
    }

    // ---------------------------------------------------------------------
    // 组件：官方「更多」菜单内容（保留「更多」入口）
    // ---------------------------------------------------------------------
    /**
     * 「更多」菜单：全部面板列表 + 固定开关。
     * @param {object} props slot props（entries / onOpen / onPinnedChange / onDismiss）。
     * @returns {object} node。
     */
    function MoreMenu(props) {
      useStore();
      const onDismiss = typeof props.onDismiss === "function" ? props.onDismiss : () => {};
      const onOpen = typeof props.onOpen === "function" ? props.onOpen : null;
      return h(
        "div",
        { className: "dshdrawer-menu" },
        state.panels.map((panel) => {
          const pinned = panel.origin === "builtin" ? true : !state.hidden.has(panel.id);
          return h(
            "div",
            {
              key: panel.id,
              className: "dshdrawer-menu-row",
              onClick: () => {
                if (onOpen) onOpen(panel.id);
                onDismiss();
              },
            },
            h(PanelIcon, { panel, size: 16 }),
            h("span", { className: "dshdrawer-menu-label" }, labelOf(panel)),
            panel.origin === "builtin"
              ? h(LockGlyph, { size: 13 })
              : h(Switch, {
                  on: pinned,
                  onChange: (next) => setPanelHidden(panel.id, !next),
                })
          );
        })
      );
    }

    // ---------------------------------------------------------------------
    // 组件：抽屉内容
    // ---------------------------------------------------------------------
    /**
     * 面板行。
     * @param {{panel: object, pinned: boolean, locked: boolean, onToggle: Function, onOpen: Function, onPointerDown: Function}} props props。
     * @returns {object} node。
     */
    function PanelRow({ panel, pinned, locked, isTarget, onToggle, onOpen, onPointerDown }) {
      return h(
        "div",
        {
          className: "dshdrawer-row" + (isTarget ? " is-target" : ""),
          "data-panel-id": panel.id,
          role: "button",
          tabIndex: 0,
          onPointerDown: (event) => {
            if (event.target && event.target.closest && event.target.closest(".dshdrawer-switch")) return;
            onPointerDown(panel, event);
          },
          onClick: () => onOpen(panel),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen(panel);
            }
          },
        },
        h("span", { className: "dshdrawer-grip" }, h(GripDots)),
        h(PanelIcon, { panel, size: 18 }),
        h(
          "span",
          { className: "dshdrawer-meta" },
          h("span", { className: "dshdrawer-name" }, labelOf(panel)),
          h("span", { className: "dshdrawer-pkg" }, panel.pkg)
        ),
        locked
          ? h(LockGlyph, { size: 14 })
          : h(Switch, { on: pinned, onChange: (next) => onToggle(panel.id, !next) })
      );
    }

    /**
     * 分组标题。
     * @param {{title: string, count: number, action?: {label: string, run: Function}}} props props。
     * @returns {object} node。
     */
    function GroupHeader({ title, count, action }) {
      return h(
        "div",
        { className: "dshdrawer-group-head" },
        h("span", { className: "dshdrawer-group-title" }, title, h("span", { className: "dshdrawer-group-count" }, "(" + count + ")")),
        action
          ? h(
              "button",
              {
                type: "button",
                className: "dshdrawer-link",
                onClick: () => action.run(),
              },
              action.label
            )
          : null
      );
    }

    /**
     * 抽屉主体：标题 / 搜索 / 分组列表 / 提示。
     * @param {{onToggle: Function, onOpen: Function, onRowPointerDown: Function, variant?: string}} props props。
     * @returns {object} node。
     */
    function DrawerBody(props) {
      useStore();
      const [query, setQuery] = useState("");
      const variant = props.variant === "page" ? "page" : "panel";
      const hidden = state.hidden;
      const panels = state.panels;
      const ranks = rankMap();
      const byRank = (list) =>
        list.slice().sort((a, b) => (ranks.get(a.id) ?? 1e6) - (ranks.get(b.id) ?? 1e6));

      const builtin = byRank(panels.filter((panel) => panel.origin === "builtin"));
      const pinned = byRank(panels.filter((panel) => panel.origin !== "builtin" && !hidden.has(panel.id)));
      const third = byRank(panels.filter((panel) => hidden.has(panel.id) && panel.origin === "third"));
      const own = byRank(panels.filter((panel) => hidden.has(panel.id) && panel.origin === "own"));

      const keyword = query.trim().toLowerCase();
      const match = (panel) =>
        !keyword || (labelOf(panel) + " " + panel.pkg).toLowerCase().includes(keyword);
      const keep = (list) => list.filter(match);

      const hiddenCount = panels.filter((panel) => panel.origin !== "builtin" && hidden.has(panel.id)).length;

      const groups = [
        { key: "builtin", title: "常驻 · 内置", items: keep(builtin), locked: true },
        {
          key: "pinned",
          title: "固定在侧栏",
          items: keep(pinned),
          action: pinned.length > 0 ? { label: "全部收起", run: () => pinned.forEach((panel) => setPanelHidden(panel.id, true)) } : null,
        },
        {
          key: "third",
          title: "下载的第三方插件",
          items: keep(third),
          action: third.length > 0 ? { label: "全部固定", run: () => third.forEach((panel) => setPanelHidden(panel.id, false)) } : null,
        },
        {
          key: "own",
          title: "我的插件",
          items: keep(own),
          action: own.length > 0 ? { label: "全部固定", run: () => own.forEach((panel) => setPanelHidden(panel.id, false)) } : null,
        },
      ].filter((group) => group.items.length > 0);

      const data = state.context;
      const installed = data && Array.isArray(data.installed) ? data.installed : [];
      const rowMeta = data && Array.isArray(data.rows) ? data.rows : [];
      const mapped = new Set();
      for (const panel of panels) {
        const row = rowMeta.find((item) => item && item.id === panel.id);
        if (row && row.name) mapped.add(row.name);
        for (const item of installed) {
          if (item && normalizeName(item.name) === panel.id) mapped.add(item.name);
        }
      }
      const skipInstalled = new Set(["dsh-drawer", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
      const extras = installed.filter(
        (item) =>
          item &&
          !skipInstalled.has(item.name) &&
          !mapped.has(item.name) &&
          (!keyword || (item.name + " " + (item.description || "")).toLowerCase().includes(keyword))
      );

      return h(
        "div",
        { className: "dshdrawer-body dshdrawer-body-" + variant },
        h(
          "div",
          { className: "dshdrawer-head" },
          h(
            "div",
            { className: "dshdrawer-title-row" },
            h("h2", { className: "dshdrawer-title" }, "抽屉"),
            h("span", { className: "dshdrawer-count" }, String(hiddenCount)),
            h(
              "button",
              { type: "button", className: "dshdrawer-iconbtn", "aria-label": "关闭抽屉", onClick: () => closeDrawer() },
              h(CloseGlyph, { size: 16 })
            )
          ),
          h("p", { className: "dshdrawer-sub" }, "常用面板留在侧栏，其余的收在这里；按住面板可上下拖动排序、左右拖动收纳。")
        ),
        h(
          "label",
          { className: "dshdrawer-search" },
          h(SearchGlyph, { size: 14 }),
          h("input", {
            value: query,
            placeholder: "搜索面板",
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setQuery("");
              }
            },
          })
        ),
        h(
          "div",
          { className: "dshdrawer-scroll" },
          groups.length === 0
            ? h("div", { className: "dshdrawer-empty" }, "没有匹配的面板")
            : groups.map((group) =>
                h(
                  "section",
                  { key: group.key, className: "dshdrawer-group" },
                  h(GroupHeader, { title: group.title, count: group.items.length, action: group.action }),
                  group.items.map((panel) =>
                    h(PanelRow, {
                      key: panel.id,
                      panel,
                      pinned: panel.origin === "builtin" ? true : !hidden.has(panel.id),
                      locked: panel.origin === "builtin",
                      isTarget: state.dropTargetId === panel.id,
                      onToggle: props.onToggle,
                      onOpen: props.onOpen,
                      onPointerDown: props.onRowPointerDown,
                    })
                  )
                )
              ),
          third.length === 0 && own.length === 0
            ? h(
                "div",
                { className: "dshdrawer-dropempty" },
                h(DrawerGlyph, { size: 18 }),
                h("span", null, "还没有收起的面板。按住上面的面板拖到抽屉里，左侧图标就会消失。")
              )
            : null,
          extras.length > 0
            ? h(
                "section",
                { className: "dshdrawer-group dshdrawer-installed" },
                h(
                  "div",
                  { className: "dshdrawer-group-head" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dshdrawer-installed-toggle",
                      onClick: () => set({ installedOpen: !state.installedOpen }),
                    },
                    h("span", { className: "dshdrawer-chevron" + (state.installedOpen ? " is-open" : "") }, "▶"),
                    h("span", { className: "dshdrawer-group-title" }, "已安装插件 · 无侧栏入口"),
                    h("span", { className: "dshdrawer-group-count" }, "(" + extras.length + ")")
                  ),
                  h(
                    "button",
                    { type: "button", className: "dshdrawer-link", onClick: () => openPanelId("plugins") },
                    "打开插件页"
                  )
                ),
                state.installedOpen
                  ? extras.map((item) =>
                      h(
                        "div",
                        {
                          key: item.name,
                          className: "dshdrawer-installed-row",
                          title: item.description || item.name,
                          onClick: () => openPanelId("plugins"),
                        },
                        h(
                          "div",
                          { className: "dshdrawer-installed-main" },
                          h("span", { className: "dshdrawer-installed-name" }, item.name),
                          h("span", { className: "dshdrawer-pill" }, originLabel(item.origin))
                        ),
                        h(
                          "span",
                          { className: "dshdrawer-installed-desc" },
                          item.description || (item.origin === "builtin" ? "内置插件 · 无侧栏入口" : "已安装 · 无侧栏入口")
                        )
                      )
                    )
                  : null
              )
            : null,
          h(
            "div",
            { className: "dshdrawer-tip" },
            h(DrawerGlyph, { size: 14 }),
            h(
              "div",
              null,
              h("strong", null, "怎么用"),
              h("p", null, "按住面板上下拖动 = 调整显示顺序；拖到抽屉 = 收起（左侧图标消失）；拖回侧栏 = 重新显示。")
            )
          )
        ),
        h(
          "div",
          { className: "dshdrawer-foot" },
          h("span", null, "上下拖排序 · 左右拖收纳 · Esc 关闭"),
          h(
            "span",
            { className: "dshdrawer-foot-right" },
            h("button", { type: "button", className: "dshdrawer-link", onClick: () => resetOrder() }, "恢复默认顺序"),
            h("span", null, panels.length + " 个面板 · 侧栏 " + Math.max(0, panels.length - (third.length + own.length)))
          )
        )
      );
    }

    // ---------------------------------------------------------------------
    // 组件：宽抽屉浮层（shell.overlay）
    // ---------------------------------------------------------------------
    /**
     * 浮层：抽屉面板 + 拖拽幽灵 + 侧栏投放区。
     * @returns {object} node。
     */
    function Overlay() {
      useStore();
      const dragRef = useRef({ candidate: null, active: false });
      const suppressRef = useRef(0);

      useEffect(() => {
        /**
         * 从侧栏行按钮识别可拖拽面板：按钮 aria-label 即面板名。
         * @param {EventTarget} target 事件目标。
         * @param {number} x 指针 x。
         * @param {number} y 指针 y。
         * @returns {object|null} 候选。
         */
        function railCandidate(target, x, y) {
          if (!target || !target.closest) return null;
          const button = target.closest("button");
          if (!button) return null;
          if (button.closest(".dshdrawer-panel") || button.closest(".dshdrawer-menu")) return null;
          if (button.closest(".dshdrawer-trigger") || button.querySelector(".dshdrawer-trigger")) return null;
          const label = button.getAttribute("aria-label");
          const nav = button.closest("nav");
          if (!label || !nav) return null;
          let panel = state.panels.find((item) => labelOf(item) === label) || null;
          if (!panel) {
            const buttons = Array.from(nav.querySelectorAll("button"));
            const index = buttons.indexOf(button);
            const id = index >= 0 ? state.navOrder[index] : null;
            if (id) panel = state.panels.find((item) => item.id === id) || null;
          }
          if (!panel) return null;
          return { id: panel.id, label: labelOf(panel), startX: x, startY: y, source: "rail", builtin: panel.origin === "builtin" };
        }

        /**
         * 命中抽屉里的面板行（排序插入点）。
         * @param {EventTarget} target 事件目标。
         * @returns {string|null} 面板 id。
         */
        function drawerRowTarget(target) {
          if (!target || !target.closest) return null;
          const row = target.closest("[data-panel-id]");
          if (!row || !row.closest(".dshdrawer-panel")) return null;
          const id = row.getAttribute("data-panel-id");
          return id && id !== PANEL_ID ? id : null;
        }

        /**
         * 命中侧栏面板行（排序插入线）。
         * @param {EventTarget} target 事件目标。
         * @returns {{id: string, top: number, left: number, width: number}|null} 命中信息。
         */
        function railRowTarget(target) {
          if (!target || !target.closest) return null;
          const button = target.closest("button");
          if (!button) return null;
          if (button.closest(".dshdrawer-panel") || button.closest(".dshdrawer-menu")) return null;
          if (button.closest(".dshdrawer-trigger") || button.querySelector(".dshdrawer-trigger")) return null;
          const nav = button.closest("nav");
          const label = button.getAttribute("aria-label");
          if (!nav || !label) return null;
          let panel = state.panels.find((item) => labelOf(item) === label) || null;
          if (!panel) {
            const buttons = Array.from(nav.querySelectorAll("button"));
            const index = buttons.indexOf(button);
            const id = index >= 0 ? state.navOrder[index] : null;
            if (id) panel = state.panels.find((item) => item.id === id) || null;
          }
          if (!panel) return null;
          const rect = button.getBoundingClientRect();
          return { id: panel.id, top: rect.top, left: rect.left, width: rect.width };
        }

        /** 指针按下：记录候选 / 点击外部关闭抽屉。 @param {object} event 事件。 @returns {void} */
        const onPointerDown = (event) => {
          if (!dragRef.current.candidate) {
            const candidate = railCandidate(event.target, event.clientX, event.clientY);
            if (candidate) dragRef.current.candidate = candidate;
          }
          if (!state.drawerOpen || dragRef.current.candidate) return;
          const target = event.target;
          const insidePanel = target && target.closest && target.closest(".dshdrawer-panel");
          const onTrigger = target && target.closest && target.closest(".dshdrawer-trigger");
          if (!insidePanel && !onTrigger) closeDrawer();
        };

        /** 指针移动：超过阈值后进入拖拽。 @param {object} event 事件。 @returns {void} */
        const onPointerMove = (event) => {
          const drag = dragRef.current;
          const candidate = drag.candidate;
          if (!candidate) return;
          if (!drag.active) {
            const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
            if (distance < DRAG_THRESHOLD) return;
            drag.active = true;
            drag.autoOpened = false;
            suppressRef.current = Date.now() + 400;
            document.body.classList.add("dshdrawer-dragging");
          }
          if (!state.drawerOpen && event.clientX >= state.sidebarRight - 4) {
            drag.autoOpened = true;
            set({ drawerOpen: true });
          }
          const rowId = drawerRowTarget(event.target);
          let rail = null;
          if (!rowId) {
            const hit = railRowTarget(event.target);
            if (hit && hit.id !== candidate.id) rail = hit;
          }
          set({
            drag: { id: candidate.id, label: candidate.label, x: event.clientX, y: event.clientY, source: candidate.source },
            dropTargetId: rowId,
            railDrop: rail,
          });
        };

        /** 指针抬起：按落点决定收起/放回。 @param {object} event 事件。 @returns {void} */
        const onPointerUp = (event) => {
          const drag = dragRef.current;
          const candidate = drag.candidate;
          const active = drag.active;
          drag.candidate = null;
          drag.active = false;
          document.body.classList.remove("dshdrawer-dragging");
          if (!candidate) return;
          if (!active) {
            if (candidate.source === "rail" && state.drawerOpen) closeDrawer();
            return;
          }
          const rowTargetId = drawerRowTarget(event.target);
          const railHit = railRowTarget(event.target);
          set({ drag: null, dropTargetId: null, railDrop: null });
          const right = state.sidebarRight;
          const overRail = event.clientX < right;
          const overDrawer = event.clientX >= right && event.clientX <= right + state.width;
          let handled = false;
          if (candidate.source === "rail") {
            if (overDrawer) {
              if (candidate.builtin) {
                handled = false;
              } else {
                if (rowTargetId && rowTargetId !== candidate.id) movePanel(candidate.id, rowTargetId);
                setPanelHidden(candidate.id, true);
                handled = true;
              }
            } else if (overRail && railHit && railHit.id !== candidate.id) {
              movePanel(candidate.id, railHit.id);
              handled = true;
            }
          } else {
            if (overRail) {
              setPanelHidden(candidate.id, false);
              if (railHit && railHit.id !== candidate.id) movePanel(candidate.id, railHit.id);
              handled = true;
            } else if (rowTargetId && rowTargetId !== candidate.id) {
              movePanel(candidate.id, rowTargetId);
              handled = true;
            }
          }
          if (!handled && drag.autoOpened) closeDrawer();
        };

        /** 键盘：Esc 取消拖拽 / 关闭抽屉；Cmd/Ctrl+K 打开抽屉。 @param {object} event 事件。 @returns {void} */
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            if (dragRef.current.candidate) {
              dragRef.current.candidate = null;
              dragRef.current.active = false;
              document.body.classList.remove("dshdrawer-dragging");
              set({ drag: null, dropTargetId: null, railDrop: null });
              return;
            }
            closeDrawer();
            return;
          }
          if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
            event.preventDefault();
            toggleDrawer();
          }
        };

        /** 拖拽结束后吞掉紧随其后的 click，避免误打开面板。 @param {object} event 事件。 @returns {void} */
        const onClickCapture = (event) => {
          if (Date.now() < suppressRef.current) {
            suppressRef.current = 0;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          const button = event.target && event.target.closest ? event.target.closest("button") : null;
          if (button && button.closest("nav") && button.getAttribute("aria-label") === "抽屉") {
            event.preventDefault();
            event.stopPropagation();
            toggleDrawer();
          }
        };

        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("pointermove", onPointerMove, true);
        document.addEventListener("pointerup", onPointerUp, true);
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("click", onClickCapture, true);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("pointermove", onPointerMove, true);
          document.removeEventListener("pointerup", onPointerUp, true);
          document.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("click", onClickCapture, true);
          document.body.classList.remove("dshdrawer-dragging");
        };
      }, []);

      const drag = state.drag;

      /**
       * 从抽屉行开始拖拽。
       * @param {object} panel 面板。
       * @param {object} event 指针事件。
       * @returns {void}
       */
      const onRowPointerDown = (panel, event) => {
        if (event.button !== undefined && event.button !== 0) return;
        dragRef.current.candidate = {
          id: panel.id,
          label: labelOf(panel),
          startX: event.clientX,
          startY: event.clientY,
          source: "drawer",
        };
      };

      return h(
        "div",
        { className: "dshdrawer-layer" },
        state.railDrop
          ? h("div", {
              className: "dshdrawer-reorderline",
              style: {
                top: Math.max(0, state.railDrop.top - 2) + "px",
                left: state.railDrop.left + "px",
                width: state.railDrop.width + "px",
              },
            })
          : null,
        drag && drag.source === "drawer" && !state.railDrop
          ? h(
              "div",
              { className: "dshdrawer-droprail", style: { width: Math.max(0, state.sidebarRight - 16) + "px" } },
              h("span", { className: "dshdrawer-droprail-label" }, "松手放回侧栏"),
              h("span", { className: "dshdrawer-droprail-hint" }, "拖回左侧后，图标会重新出现在侧栏")
            )
          : null,
        state.drawerOpen
          ? h(
              "div",
              {
                className: "dshdrawer-panel" + (drag && drag.source === "rail" ? " is-drop" : ""),
                style: { left: state.sidebarRight + "px", width: state.width + "px" },
              },
              h(DrawerBody, {
                onToggle: setPanelHidden,
                onOpen: openPanel,
                onRowPointerDown,
                variant: "panel",
              })
            )
          : null,
        drag
          ? h(
              "div",
              { className: "dshdrawer-ghost", style: { left: drag.x + 14 + "px", top: drag.y + 10 + "px" } },
              h(DrawerGlyph, { size: 14 }),
              h("span", null, drag.label)
            )
          : null
      );
    }

    // ---------------------------------------------------------------------
    // 组件：main 整页兜底
    // ---------------------------------------------------------------------
    /**
     * 键盘（Enter）打开面板时的整页版本。
     * @returns {object} node。
     */
    function DrawerPage() {
      useStore();
      return h(
        "div",
        { className: "dshdrawer-page" },
        h(
          "div",
          { className: "dshdrawer-page-card" },
          h(DrawerBody, {
            onToggle: setPanelHidden,
            onOpen: openPanel,
            onRowPointerDown: () => {},
            variant: "page",
          })
        )
      );
    }

    // ---------------------------------------------------------------------
    // 样式（只注入一次；类名 dshdrawer- 前缀；配色只依赖 --dsw-alias-* 令牌）
    // ---------------------------------------------------------------------
    const CSS = [
      ".dshdrawer-layer{position:fixed;inset:0;z-index:70;pointer-events:none}",
      ".dshdrawer-dragging{cursor:grabbing!important;user-select:none!important}",
      ".dshdrawer-dragging *{cursor:grabbing!important}",
      ".dshdrawer-trigger{position:relative;display:inline-flex;align-items:center;justify-content:center;color:inherit}",
      ".dshdrawer-trigger.is-open{color:var(--dsw-alias-brand-primary,#0f1115)}",
      ".dshdrawer-badge{position:absolute;top:-7px;right:-10px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-brand-primary,#0f1115);color:var(--dsw-alias-label-invert,#fff);font-size:9px;line-height:14px;text-align:center;font-weight:600}",
      ".dshdrawer-panel{position:absolute;top:0;bottom:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border-left:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));border-radius:0 16px 16px 0;box-shadow:6px 0 26px rgba(15,17,21,.10);pointer-events:auto;overflow:hidden}",
      ".dshdrawer-panel.is-drop{box-shadow:inset 0 0 0 2px rgba(74,125,255,.55),6px 0 26px rgba(15,17,21,.10)}",
      ".dshdrawer-body{display:flex;flex-direction:column;height:100%;min-height:0}",
      ".dshdrawer-head{flex:none;padding:20px 20px 0}",
      ".dshdrawer-title-row{display:flex;align-items:center;gap:10px}",
      ".dshdrawer-title{margin:0;font-size:18px;font-weight:700;letter-spacing:.2px}",
      ".dshdrawer-count{min-width:24px;height:20px;padding:0 7px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#f1f3f5);color:var(--dsw-alias-label-secondary,#61666b);font-size:11px;line-height:20px;text-align:center}",
      ".dshdrawer-iconbtn{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}",
      ".dshdrawer-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f5)}",
      ".dshdrawer-sub{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}",
      ".dshdrawer-search{flex:none;display:flex;align-items:center;gap:8px;margin:16px 20px 0;padding:0 12px;height:38px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#f5f6f7);color:var(--dsw-alias-label-tertiary,#81858c)}",
      ".dshdrawer-search input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:13px}",
      ".dshdrawer-scroll{flex:1;min-height:0;overflow-y:auto;padding:16px 20px 20px}",
      ".dshdrawer-group{margin-bottom:18px}",
      ".dshdrawer-group:last-of-type{margin-bottom:8px}",
      ".dshdrawer-group-head{display:flex;align-items:center;margin-bottom:8px;padding:0 2px}",
      ".dshdrawer-group-title{flex:1;font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-tertiary,#81858c)}",
      ".dshdrawer-group-count{margin-left:5px;font-size:10.5px}",
      ".dshdrawer-link{border:none;background:transparent;padding:2px 4px;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;border-radius:6px}",
      ".dshdrawer-link:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f5)}",
      ".dshdrawer-row{display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:12px;cursor:grab;user-select:none;touch-action:none}",
      ".dshdrawer-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f5)}",
      ".dshdrawer-row.is-target{box-shadow:inset 0 2px 0 0 var(--dsw-alias-state-business-primary,#4a7dff)}",
      ".dshdrawer-reorderline{position:fixed;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary,#4a7dff);pointer-events:none;z-index:95;box-shadow:0 0 0 1px rgba(74,125,255,.18)}",
      ".dshdrawer-grip{display:inline-flex;color:var(--dsw-alias-border-l3,#c9cdd3);flex:none}",
      ".dshdrawer-ico{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dshdrawer-dot{width:16px;height:16px;border-radius:5px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.1));display:inline-block}",
      ".dshdrawer-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dshdrawer-name{font-size:13px;line-height:1.35;color:var(--dsw-alias-label-primary,#0f1115);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshdrawer-pkg{font-size:10.5px;line-height:1.35;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshdrawer-lock{color:var(--dsw-alias-label-tertiary,#a6acb4);flex:none}",
      ".dshdrawer-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14));cursor:pointer;transition:background .15s}",
      ".dshdrawer-switch.is-on{background:var(--dsw-alias-brand-primary,#0f1115)}",
      ".dshdrawer-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}",
      ".dshdrawer-switch.is-on .dshdrawer-knob{transform:translateX(16px)}",
      ".dshdrawer-empty{padding:24px 0;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#81858c)}",
      ".dshdrawer-dropempty{display:flex;flex-direction:column;align-items:center;gap:8px;margin:4px 0 16px;padding:18px 14px;border:1.5px dashed var(--dsw-alias-border-l3,#c9cdd3);border-radius:12px;color:var(--dsw-alias-label-tertiary,#81858c);font-size:11.5px;line-height:1.6;text-align:center}",
      ".dshdrawer-tip{display:flex;gap:10px;align-items:flex-start;margin-top:8px;padding:12px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#f5f6f7);color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dshdrawer-tip strong{display:block;font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);margin-bottom:4px}",
      ".dshdrawer-tip p{margin:0;font-size:11.5px;line-height:1.55}",
      ".dshdrawer-installed{margin-top:6px;padding-top:14px;border-top:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.1))}",
      ".dshdrawer-installed-toggle{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}",
      ".dshdrawer-chevron{display:inline-block;font-size:9px;color:var(--dsw-alias-label-tertiary,#81858c);transition:transform .15s}",
      ".dshdrawer-chevron.is-open{transform:rotate(90deg)}",
      ".dshdrawer-installed-row{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border-radius:10px;cursor:pointer}",
      ".dshdrawer-installed-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f5)}",
      ".dshdrawer-installed-main{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dshdrawer-installed-name{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshdrawer-pill{flex:none;font-size:9.5px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-overlay,#f1f3f5);color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dshdrawer-installed-desc{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshdrawer-foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c)}",
      ".dshdrawer-foot-right{display:inline-flex;align-items:center;gap:10px}",
      ".dshdrawer-ghost{position:fixed;z-index:90;display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));box-shadow:0 12px 30px rgba(15,17,21,.2);font-size:13px;pointer-events:none;white-space:nowrap}",
      ".dshdrawer-droprail{position:absolute;top:10px;bottom:10px;left:8px;border:1.5px dashed var(--dsw-alias-state-business-primary,#4a7dff);border-radius:14px;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding-top:12px}",
      ".dshdrawer-droprail-label{font-size:12px;font-weight:600;color:var(--dsw-alias-state-business-primary,#4a7dff);background:var(--dsw-alias-bg-layer-1,#fff);padding:2px 8px;border-radius:8px}",
      ".dshdrawer-droprail-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#81858c);background:var(--dsw-alias-bg-layer-1,#fff);padding:1px 8px;border-radius:8px}",
      ".dshdrawer-menu{display:flex;flex-direction:column;gap:1px;padding:4px;max-height:60vh;overflow:auto}",
      ".dshdrawer-menu-row{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dshdrawer-menu-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f5)}",
      ".dshdrawer-menu-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshdrawer-page{height:100%;min-height:0;overflow:auto;display:flex;justify-content:center;align-items:flex-start;background:var(--dsw-alias-bg-base,#fff)}",
      ".dshdrawer-page-card{width:min(560px,calc(100% - 40px));margin:6vh 0 24px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));border-radius:16px;box-shadow:0 12px 40px rgba(15,17,21,.08)}",
      ".dshdrawer-page-card .dshdrawer-body{height:auto;max-height:70vh}",
    ].join("\n");

    /** 只注入一次 `<style>`。 @returns {void} */
    function injectStyles() {
      if (typeof document === "undefined") return;
      const marker = 'style[data-plugin="dsh-drawer"]';
      if (document.querySelector(marker)) return;
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-drawer";
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }

    // ---------------------------------------------------------------------
    // 面板同步
    // ---------------------------------------------------------------------
    /** 排序 rank 表（id → 序号）。 */
    function rankMap() {
      const map = new Map();
      state.order.forEach((id, index) => map.set(id, index));
      return map;
    }

    /**
     * 把面板集合并入自定义排序：保留已有顺序，新面板追加到末尾，卸载的面板剔除。
     * @param {string[]} ids 当前全部面板 id（含 drawer）。
     * @returns {void}
     */
    function ensureOrder(ids) {
      const keep = new Set(ids.filter((id) => id !== PANEL_ID));
      const next = state.order.filter((id) => keep.has(id));
      for (const id of ids) {
        if (id !== PANEL_ID && !next.includes(id)) next.push(id);
      }
      const changed = next.length !== state.order.length || next.some((id, index) => state.order[index] !== id);
      if (changed) {
        state.order = next;
        saveOrder(next);
      }
    }

    /**
     * 生成/刷新侧栏行的显示顺序（CSS `order`）。
     *
     * 面板行用大负数，抽屉行用 -1000，官方「更多」保持默认 0 → 永远在最后。
     * 同时写 `nav > :has(...)`，兼容行外面再包一层 wrapper 的实现。
     * @returns {void}
     */
    function updateOrderCss() {
      if (typeof document === "undefined") return;
      let style = document.querySelector('style[data-plugin="dsh-drawer-order"]');
      if (!style) {
        style = document.createElement("style");
        style.dataset.plugin = "dsh-drawer-order";
        (document.head || document.documentElement).appendChild(style);
      }
      const ranks = rankMap();
      const sorted = state.panels
        .slice()
        .sort((a, b) => (ranks.get(a.id) ?? 1e6) - (ranks.get(b.id) ?? 1e6));
      const rules = [];
      sorted.forEach((panel, index) => {
        const label = labelOf(panel).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const value = -100000 + index * 10;
        rules.push('nav button[aria-label="' + label + '"]{order:' + value + '!important}');
        rules.push('nav > :has(button[aria-label="' + label + '"]){order:' + value + '!important}');
      });
      rules.push("nav button:has(.dshdrawer-trigger){order:-1000!important}");
      rules.push("nav > :has(.dshdrawer-trigger){order:-1000!important}");
      style.textContent = rules.join("\n");
    }

    /**
     * 把某面板移动到另一面板之前（自定义排序）。
     * @param {string} id 被拖动的面板。
     * @param {string} beforeId 目标面板（插到它前面）。
     * @returns {void}
     */
    function movePanel(id, beforeId) {
      if (!id || !beforeId || id === beforeId) return;
      const next = state.order.filter((item) => item !== id);
      const index = next.indexOf(beforeId);
      if (index === -1) next.push(id);
      else next.splice(index, 0, id);
      state.order = next;
      saveOrder(next);
      updateOrderCss();
      emit();
    }

    /** 恢复注册顺序（清空自定义排序）。 @returns {void} */
    function resetOrder() {
      const next = state.panels
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((panel) => panel.id);
      state.order = next;
      saveOrder(next);
      updateOrderCss();
      emit();
    }

    /**
     * 同步侧栏面板集合与来源分类。
     * @param {object} ctx client context。
     * @returns {void}
     */
    function syncPanels(ctx) {
      let entries = [];
      try {
        entries = ctx.slots.entriesOfSlot("sidebar.panellist") || [];
      } catch (error) {
        console.warn("[drawer] 读取面板失败", error);
        return;
      }
      const byId = new Map();
      for (const entry of entries) {
        const options = (entry && entry.options) || {};
        const id = options.id;
        if (!id || byId.has(id)) continue;
        byId.set(id, {
          id,
          labelSource: options.label,
          order: typeof options.order === "number" ? options.order : 0,
          component: entry.component,
        });
      }
      const all = Array.from(byId.values()).sort((a, b) => a.order - b.order);
      ensureOrder(all.map((panel) => panel.id));
      const ranks = rankMap();
      const sortedAll = all
        .slice()
        .sort((a, b) => (ranks.get(a.id) ?? 1e6) - (ranks.get(b.id) ?? 1e6));
      const navOrder = sortedAll.map((panel) => panel.id);
      const panels = sortedAll
        .filter((panel) => panel.id !== PANEL_ID)
        .map((panel) => Object.assign({}, panel, classifyPanel(panel.id)));
      if (!state.face) state.face = resolveFace(ctx);
      set({ panels, navOrder });
      updateOrderCss();
      reconcilePins();
    }

    /**
     * 拉取 profile 上下文（失败时保持内置兜底）。
     * @returns {Promise<void>} 完成。
     */
    async function loadContext() {
      try {
        const response = await fetch(API_BASE + "/context", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const data = await response.json();
        if (data && data.ok) {
          const config = data.config && typeof data.config === "object" ? data.config : {};
          state.context = data;
          state.hostConfig = config;
          if (config.width) state.width = Math.min(640, Math.max(320, Number(config.width) || DEFAULT_WIDTH));
          if (runtimeCtx) syncPanels(runtimeCtx);
        }
      } catch {
        /* 取不到就用内置兜底分组 */
      }
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------
    /** 依赖的客户端服务。 */
    const inject = ["slots"];

    /**
     * 注册入口行 / 更多菜单 / 抽屉浮层 / 整页兜底。
     * @param {object} ctx client context。
     * @returns {void}
     */
    function apply(ctx) {
      runtimeCtx = ctx;
      injectStyles();
      state.hidden = loadHidden();
      state.order = loadOrder();

      // 侧栏「抽屉」入口：order 取最大 → 排在官方「更多」上面。
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 900, label: "抽屉" }, Trigger)
      );

      // 官方「更多」菜单：注册后「更多」这一行才会显示，作为兜底入口保留。
      ctx.slots.inject("sidebar.panellist.actions", () =>
        ctx.slots.register({ name: "sidebar.panellist.actions", id: "drawer-more", order: 0 }, MoreMenu)
      );

      // 面板集合同步（含后续新装插件）。
      ctx.slots.inject("sidebar.panellist", () => {
        syncPanels(ctx);
        let off = null;
        try {
          off = ctx.slots.subscribe("sidebar.panellist", () => syncPanels(ctx));
        } catch {
          off = null;
        }
        return () => {
          if (typeof off === "function") off();
        };
      });

      // 侧栏注入面（setPinned）在 sidebar 声明后可用。
      ctx.slots.inject("sidebar", () => {
        state.face = resolveFace(ctx);
        reconcilePins();
        return () => {
          state.face = null;
        };
      });

      // 宽抽屉 + 拖拽浮层。
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "drawer-overlay", order: 500 }, Overlay)
      );

      // 键盘（Enter）落到面板 id 时的整页兜底。
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, DrawerPage));

      loadContext().catch(() => {});


      // 卸载时把面板全部放回侧栏，避免留下"看不见的图标"。
      ctx.effect(
        () => () => {
          for (const panel of state.panels) {
            try {
              if (state.face) state.face.setPinned(panel.id, true);
            } catch {
              /* 忽略 */
            }
          }
          try {
            const tag = document.querySelector('style[data-plugin="dsh-drawer-order"]');
            if (tag) tag.remove();
          } catch {
            /* 忽略 */
          }
        },
        "drawer: restore pins"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
