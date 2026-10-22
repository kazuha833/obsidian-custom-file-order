'use strict';

/**
 * 自定义文件排序 / Custom File Order
 * ------------------------------------------------------------------
 * 让 Obsidian 文件浏览器按「每个文件夹各自记住的顺序」展示文件与子文件夹。
 *
 * 实现要点：
 *   1. 核心是重写 FileExplorerView.getSortedFolderItems(folder)。
 *      Obsidian 1.x 的文件浏览器渲染某个文件夹的子项时，唯一会调用这个方法，
 *      我们把它的返回值按保存的顺序重排后再交还给 Obsidian，
 *      折叠、搜索、无限滚动、拖拽移动文件等原生行为都不受影响。
 *   2. 交互层：在文件/文件夹行左侧注入一个拖拽手柄（⠿），
 *      用 Pointer Events + setPointerCapture 自行处理拖拽，
 *      不与 Obsidian 原生的「拖拽移动文件到文件夹」冲突。
 *   3. 兜底交互：右键菜单、命令面板里的上移/下移/置顶/置底，
 *      即使拖拽失效也能完成排序。
 *
 * 顺序以「文件夹路径 -> [子项名称, ...]」的形式保存在 data.json。
 * 未出现在列表里的新文件会排在末尾（保持 Obsidian 原生排序）。
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, setIcon } = obsidian;

const ROOT_PATH = '/';
const GRIP_ICON = 'grip-vertical';
const DATA_VERSION = 1;

const DEFAULT_SETTINGS = {
  enabled: true,        // 总开关：关闭后完全恢复 Obsidian 原生排序
  showGrip: true,       // 是否在文件行左侧显示拖拽手柄
  debug: false,         // 排查用：把拖拽诊断写进库根目录的 .cfo-debug.json
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function basename(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function dirname(path) {
  if (!path || path === ROOT_PATH) return ROOT_PATH;
  const i = path.lastIndexOf('/');
  return i === -1 ? ROOT_PATH : path.slice(0, i);
}

function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}

/** setIcon 在极老版本里不存在，退回纯文本，保证不报错。 */
function paintIcon(el, icon) {
  if (typeof setIcon === 'function') {
    try {
      setIcon(el, icon);
      return;
    } catch (e) {
      /* ignore */
    }
  }
  el.textContent = '⠿';
}

/** 把一个元素及其 4 层祖宗教名 + class 串起来，用于诊断 */
function describeChain(el) {
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && depth < 5) {
    const cls = typeof node.className === 'string' ? node.className : node.className && node.className.baseVal;
    parts.push(`${node.tagName ? node.tagName.toLowerCase() : '?'}${cls ? '.' + String(cls).trim().split(/\s+/).join('.') : ''}`);
    node = node.parentElement;
    depth++;
  }
  return parts.join(' < ');
}

/* ------------------------------------------------------------------ */
/* 主插件                                                              */
/* ------------------------------------------------------------------ */

class CustomFileOrderPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.data = { version: DATA_VERSION, orders: {} };
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.views = [];
    this.observer = null;
    this.observedContainers = new Set();
    this.drag = null;
    this.decorateFrame = null;
    this.saveSoon = debounce(() => this.persist(), 250);
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  async onload() {
    await this.loadAllData();
    console.info(
      `[custom-file-order] 已加载：已保存 ${Object.keys(this.data.orders).length} 个文件夹的自定义顺序`
    );
    this.addSettingTab(new CustomFileOrderSettingTab(this.app, this));

    this.registerCommands();
    this.registerFileMenu();
    this.registerVaultEvents();

    this.app.workspace.onLayoutReady(() => this.attach());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.attach()));
  }

  onunload() {
    this.stopObserver();
    this.unbindGlobalPointer();
    if (this.debugTimer) {
      window.clearTimeout(this.debugTimer);
      this.debugTimer = null;
    }
    this.removeGrips();
    this.unpatchViews();
    if (this.drag) this.endReorder(null, true);
  }

  /** 文件浏览器视图出现/重建后重新挂载 */
  attach() {
    this.patchViews();
    this.setupObserver();
    this.decorateSoon();
    this.bindGlobalPointer();
  }

  /**
   * 把「按住手柄」的监听挂在 document 的捕获阶段。
   * 比挂在手柄自己身上更可靠：无论 Obsidian 在任何层级对 pointerdown 做了处理，
   * 捕获阶段我们都能先拿到事件。
   */
  bindGlobalPointer() {
    if (this.onDocPointerDown) return;
    this.onDocPointerDown = (ev) => {
      const target = ev.target;
      if (!target || typeof target.closest !== 'function') return;
      const grip = target.closest('.cfo-grip');
      if (!grip) {
        // 落在文件夹标题上却没命中手柄：记下来，方便定位「按了没反应」
        const folderTitle = target.closest('.nav-folder-title');
        if (folderTitle) {
          this.debugRecord('folder-press-miss', {
            target: describeChain(target),
            viaTitle: true,
            hasGrip: !!folderTitle.querySelector('.cfo-grip'),
          });
        }
        return;
      }
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.startReorder(ev, grip);
    };
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
  }

  unbindGlobalPointer() {
    if (!this.onDocPointerDown) return;
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    this.onDocPointerDown = null;
  }

  /* ------------------------------ 诊断 ------------------------------ */

  /**
   * 记录一次拖拽诊断。
   * 默认**不写任何文件**，只有设置里打开「写入诊断日志」时才会在库根目录生成 `.cfo-debug.json`。
   * 日常点击文件夹标题也会走到这里（那是正常操作，不是异常），所以必须由开关控制。
   */
  debugRecord(kind, data) {
    if (!this.settings || !this.settings.debug) return;
    try {
      if (!this.debugLog) this.debugLog = [];
      this.debugLog.push(Object.assign({ at: new Date().toISOString(), kind }, data || {}));
      if (this.debugLog.length > 60) this.debugLog.shift();
      if (this.debugTimer) return;
      this.debugTimer = window.setTimeout(() => {
        this.debugTimer = null;
        this.flushDebug();
      }, 800);
    } catch (err) {
      /* 诊断自身绝不报错 */
    }
  }

  async flushDebug(force) {
    if (!force && (!this.settings || !this.settings.debug)) return;
    try {
      const payload = {
        plugin: 'custom-file-order',
        version: this.manifest && this.manifest.version,
        at: new Date().toISOString(),
        userAgent: navigator.userAgent,
        rows: this.describeRows(),
        events: this.debugLog || [],
      };
      await this.app.vault.adapter.write('.cfo-debug.json', JSON.stringify(payload, null, 2));
    } catch (err) {
      console.error('[custom-file-order] 写诊断文件失败', err);
    }
  }

  /** 把文件浏览器每一行的关键几何信息快照下来 */
  describeRows() {
    const out = [];
    const views = this.views && this.views.length ? this.views : this.getViews();
    for (const view of views) {
      if (!view.containerEl) continue;
      let n = 0;
      for (const row of view.containerEl.querySelectorAll('.nav-file, .nav-folder')) {
        if (n >= 40) break;
        const page = row.getBoundingClientRect();
        if (!page || page.bottom < 0 || page.top > (window.innerHeight || 1e9)) continue;
        n++;
        const title = row.querySelector('.nav-file-title, .nav-folder-title');
        const grip = title ? title.querySelector('.cfo-grip') : null;
        const g = grip ? grip.getBoundingClientRect() : null;
        let atGrip = null;
        if (g && g.width > 0) {
          const el = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2);
          atGrip = el ? describeChain(el) : 'null';
        }
        const icon = title ? title.querySelector('.tree-item-icon') : null;
        const ib = icon ? icon.getBoundingClientRect() : null;
        out.push({
          row: row.className,
          title: title ? title.className : null,
          path: this.rowPath(row),
          draggable: title ? title.draggable : null,
          grip: !!grip,
          gripRect: g ? [Math.round(g.left), Math.round(g.top), Math.round(g.width), Math.round(g.height)] : null,
          iconRect: ib ? [Math.round(ib.left), Math.round(ib.top), Math.round(ib.width), Math.round(ib.height)] : null,
          titleRect: title
            ? (() => {
                const b = title.getBoundingClientRect();
                return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
              })()
            : null,
          atGrip,
        });
      }
    }
    return out;
  }

  /* ------------------------------ 数据 ------------------------------ */

  async loadAllData() {
    const stored = (await this.loadData()) || {};
    const orders = stored.orders && typeof stored.orders === 'object' ? stored.orders : {};
    const clean = {};
    for (const [key, value] of Object.entries(orders)) {
      if (!Array.isArray(value)) continue;
      const names = value.filter((n) => typeof n === 'string' && n.length > 0);
      if (names.length) clean[key] = Array.from(new Set(names));
    }
    this.data = { version: DATA_VERSION, orders: clean };

    const settings = stored.settings && typeof stored.settings === 'object' ? stored.settings : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
  }

  async persist() {
    this.data.version = DATA_VERSION;
    await this.saveData({ version: this.data.version, orders: this.data.orders, settings: this.settings });
  }

  /* ------------------------------ 视图挂载 ------------------------------ */

  getViews() {
    const result = [];
    const leaves = this.app.workspace.getLeavesOfType('file-explorer') || [];
    for (const leaf of leaves) {
      const view = leaf && leaf.view;
      if (view && typeof view.getSortedFolderItems === 'function') result.push(view);
    }
    return result;
  }

  patchViews() {
    const views = this.getViews();
    for (const view of views) {
      if (view.__cfoOwner === this) continue;
      // 理论上只会有本插件一个主人，但重载插件时可能残留旧闭包，直接覆盖即可
      const original = view.__cfoOriginal || view.getSortedFolderItems;
      view.__cfoOriginal = original;
      view.__cfoOwner = this;
      const plugin = this;
      view.getSortedFolderItems = function (folder) {
        const items = original.apply(this, arguments);
        if (!plugin.settings.enabled) return items;
        try {
          return plugin.applyOrder(folder, items);
        } catch (err) {
          console.error('[custom-file-order] 排序失败，已退回原生排序', err);
          return items;
        }
      };
    }
    this.views = views;
    return views;
  }

  unpatchViews() {
    for (const view of this.views || []) {
      if (view.__cfoOwner === this && view.__cfoOriginal) {
        view.getSortedFolderItems = view.__cfoOriginal;
      }
      if (view.__cfoOwner === this) view.__cfoOwner = null;
    }
    this.views = [];
  }

  /** 触发文件浏览器重新排序（内部是 20ms 防抖的 requestSort） */
  refreshView(folderPath) {
    const views = this.getViews();
    this.views = views;
    for (const view of views) {
      try {
        if (typeof view.requestSort === 'function') view.requestSort();
        else if (typeof view.sort === 'function') view.sort();
      } catch (err) {
        console.error('[custom-file-order] 刷新文件浏览器失败', err);
      }
    }
    if (folderPath) this.reorderDom(folderPath);
  }

  /** 找到某个文件夹在文件浏览器里「装子项」的那个容器元素 */
  findFolderContainer(folderPath) {
    const views = this.views.length ? this.views : this.getViews();
    for (const view of views) {
      if (!view.containerEl) continue;
      for (const row of view.containerEl.querySelectorAll('.nav-file, .nav-folder')) {
        const p = this.rowPath(row);
        if (!p) continue;
        const mine = folderPath === ROOT_PATH ? p.indexOf('/') === -1 : dirname(p) === folderPath;
        if (mine) return row.parentElement;
      }
    }
    return null;
  }

  /**
   * 把 DOM 里某个文件夹的子项按保存的顺序重排。
   * 必须有这一步：Obsidian 的 requestSort 只重排根一层，
   * 展开的子文件夹不会重新查询顺序，所以子文件夹里改完必须自己把行挪到位。
   */
  reorderDom(folderPath) {
    const container = this.findFolderContainer(folderPath);
    if (!container) return;

    const rows = Array.from(container.children).filter(
      (el) => el.classList && (el.classList.contains('nav-file') || el.classList.contains('nav-folder'))
    );
    if (rows.length < 2) return;

    const names = rows.map((el) => basename(this.rowPath(el))).filter(Boolean);
    const known = new Set(names);

    // 以保存的顺序为基准，未登记的（新文件）保持当前相对顺序排在后面
    const saved = (this.data.orders[folderPath] || []).filter((n) => known.has(n));
    const seen = new Set(saved);
    const ordered = saved.slice();
    for (const n of names) if (!seen.has(n)) ordered.push(n);

    const pos = new Map();
    ordered.forEach((n, i) => pos.set(n, i));

    const keyed = rows.map((el, i) => {
      const n = basename(this.rowPath(el));
      return { el, p: pos.has(n) ? pos.get(n) : ordered.length + i };
    });
    keyed.sort((a, b) => a.p - b.p);
    for (const entry of keyed) container.appendChild(entry.el);
  }

  /* ------------------------------ 排序内核 ------------------------------ */

  itemName(item) {
    if (!item) return '';
    const file = item.file || item;
    if (file && typeof file.name === 'string' && file.name) return file.name;
    const path = item.path || file.path || '';
    return basename(path);
  }

  /**
   * 把 Obsidian 传进来的子项数组按保存的顺序重排。
   * 未记录的新项目保持原生顺序，排在后面。
   */
  applyOrder(folder, items) {
    if (!folder || !items || items.length < 2) return items;
    const order = this.data.orders[folder.path];
    if (!order || order.length < 1) return items;

    const index = new Map();
    for (let i = 0; i < order.length; i++) index.set(order[i], i);

    const known = [];
    const rest = [];
    for (const item of items) {
      if (index.has(this.itemName(item))) known.push(item);
      else rest.push(item);
    }
    if (known.length < 2) return items;

    known.sort((a, b) => index.get(this.itemName(a)) - index.get(this.itemName(b)));
    return known.concat(rest);
  }

  /** 某个文件夹「当前实际显示」的子项名称顺序（已含自定义顺序） */
  effectiveNames(folderPath) {
    const folder = this.getFolder(folderPath);
    if (!folder) return [];

    const view = this.views.find((v) => v.__cfoOwner === this) || this.getViews()[0];
    if (view && typeof view.getSortedFolderItems === 'function') {
      try {
        const items = view.getSortedFolderItems(folder);
        const names = items.map((it) => this.itemName(it)).filter(Boolean);
        // 极少数情况下（超大文件夹的懒渲染）可能缺失项目，用子项补齐
        if (names.length >= folder.children.length) return names;
        const seen = new Set(names);
        for (const child of folder.children) if (!seen.has(child.name)) names.push(child.name);
        return names;
      } catch (err) {
        /* 落到下面的兜底 */
      }
    }
    return folder.children.map((c) => c.name);
  }

  getFolder(folderPath) {
    if (!folderPath || folderPath === ROOT_PATH) return this.app.vault.getRoot();
    const file = this.app.vault.getAbstractFileByPath(folderPath);
    return file && Array.isArray(file.children) ? file : null;
  }

  setOrder(folderPath, names) {
    if (!names || names.length === 0) delete this.data.orders[folderPath];
    else this.data.orders[folderPath] = names.slice();
    this.saveSoon();
  }

  clearOrder(folderPath) {
    if (!(folderPath in this.data.orders)) return false;
    delete this.data.orders[folderPath];
    this.saveSoon();
    return true;
  }

  /* ------------------------------ 排序动作 ------------------------------ */

  /**
   * @param {'up'|'down'|'top'|'bottom'} kind
   */
  applyAction(folderPath, name, kind) {
    const names = this.effectiveNames(folderPath);
    const from = names.indexOf(name);
    if (from === -1) {
      new Notice('找不到该项目，可能已被移动或删除');
      return;
    }

    let to = from;
    if (kind === 'up') to = from - 1;
    else if (kind === 'down') to = from + 1;
    else if (kind === 'top') to = 0;
    else if (kind === 'bottom') to = names.length - 1;

    if (to < 0 || to >= names.length || to === from) {
      if (kind === 'up' || kind === 'top') new Notice('已经在最前面了');
      else new Notice('已经在最后面了');
      return;
    }

    names.splice(from, 1);
    names.splice(to, 0, name);
    this.setOrder(folderPath, names);
    this.refreshView(folderPath);
    this.decorateSoon();
  }

  runActionForFile(file, kind) {
    if (!file) {
      new Notice('请先打开或选中一个文件');
      return;
    }
    const folderPath = file.parent ? file.parent.path : ROOT_PATH;
    this.applyAction(folderPath, file.name, kind);
  }

  /** 排查用：把文件浏览器的接管情况打印到控制台 */
  diagnose() {
    const views = this.getViews();
    const patched = views.filter((v) => v.__cfoOwner === this).length;
    let titles = 0;
    let grips = 0;
    const sample = [];

    for (const view of views) {
      const container = view.containerEl;
      if (!container) continue;
      titles += container.querySelectorAll('.nav-file-title, .nav-folder-title').length;
      grips += container.querySelectorAll('.cfo-grip').length;
      const first = container.querySelector('.nav-file-title, .nav-folder-title');
      if (first && sample.length < 2) {
        const item = first.closest('.nav-file, .nav-folder');
        sample.push({
          itemClass: item ? item.className : null,
          itemPath: item ? item.getAttribute('data-path') : null,
          titlePath: first.getAttribute('data-path'),
          parentClass: item && item.parentElement ? item.parentElement.className : null,
          gripCount: first.querySelectorAll(':scope > .cfo-grip').length,
        });
      }
    }

    const info = {
      enabled: this.settings.enabled,
      showGrip: this.settings.showGrip,
      views: views.length,
      patched,
      titles,
      grips,
      savedFolders: Object.keys(this.data.orders).length,
      sample,
    };
    console.info('[custom-file-order] diagnose', info);
    this.flushDebug(true);
    new Notice(
      `诊断：文件浏览器 ${views.length} 个（已接管 ${patched}），标题 ${titles} 行，手柄 ${grips} 个。明细已写入库根目录 .cfo-debug.json`,
      8000
    );
    return info;
  }

  /* ------------------------------ 命令 ------------------------------ */

  registerCommands() {
    const make = (id, name, kind) =>
      this.addCommand({
        id,
        name,
        callback: () => this.runActionForFile(this.app.workspace.getActiveFile(), kind),
      });

    make('move-up', '自定义排序：上移当前文件', 'up');
    make('move-down', '自定义排序：下移当前文件', 'down');
    make('move-top', '自定义排序：置顶当前文件', 'top');
    make('move-bottom', '自定义排序：置底当前文件', 'bottom');

    this.addCommand({
      id: 'diagnose',
      name: '自定义排序：诊断（详情输出到开发者控制台）',
      callback: () => this.diagnose(),
    });

    this.addCommand({
      id: 'reset-current-folder',
      name: '自定义排序：重置当前文件夹的顺序',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        const folderPath = file && file.parent ? file.parent.path : ROOT_PATH;
        if (this.clearOrder(folderPath)) {
          this.refreshView(folderPath);
          new Notice('已恢复该文件夹的原生排序');
        } else {
          new Notice('该文件夹没有自定义顺序');
        }
      },
    });
  }

  /* ------------------------------ 右键菜单 ------------------------------ */

  registerFileMenu() {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!file || !file.path) return;
        const folderPath = file.parent ? file.parent.path : ROOT_PATH;
        const name = file.name;
        const hasOrder = folderPath in this.data.orders;

        menu.addItem((item) => {
          item.setTitle('自定义排序').setIcon('arrow-up-narrow-wide');
          if (typeof item.setSubmenu !== 'function') return;
          const sub = item.setSubmenu();
          if (!sub) return;

          sub.addItem((i) =>
            i
              .setTitle('上移')
              .setIcon('arrow-up')
              .onClick(() => this.applyAction(folderPath, name, 'up'))
          );
          sub.addItem((i) =>
            i
              .setTitle('下移')
              .setIcon('arrow-down')
              .onClick(() => this.applyAction(folderPath, name, 'down'))
          );
          sub.addItem((i) =>
            i
              .setTitle('置顶')
              .setIcon('chevrons-up')
              .onClick(() => this.applyAction(folderPath, name, 'top'))
          );
          sub.addItem((i) =>
            i
              .setTitle('置底')
              .setIcon('chevrons-down')
              .onClick(() => this.applyAction(folderPath, name, 'bottom'))
          );
          sub.addSeparator();
          sub.addItem((i) =>
            i
              .setTitle('重置本文件夹顺序')
              .setIcon('rotate-ccw')
              .setDisabled(!hasOrder)
              .onClick(() => {
                if (this.clearOrder(folderPath)) {
                  this.refreshView(folderPath);
                  new Notice('已恢复该文件夹的原生排序');
                }
              })
          );
        });
      })
    );
  }

  /* ------------------------------ 文件变动 ------------------------------ */

  registerVaultEvents() {
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.handleRename(file, oldPath))
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.handleDelete(file))
    );
  }

  handleRename(file, oldPath) {
    if (!file || !oldPath) return;
    const orders = this.data.orders;
    const oldName = basename(oldPath);
    const newName = file.name;
    const oldParent = dirname(oldPath);
    const newParent = file.parent ? file.parent.path : ROOT_PATH;

    // 1) 父文件夹里记录的名字要跟着改
    if (oldParent === newParent) {
      const list = orders[oldParent];
      if (list) {
        const at = list.indexOf(oldName);
        if (at !== -1 && oldName !== newName) {
          list[at] = newName;
          this.saveSoon();
        }
      }
    } else {
      // 跨文件夹移动：从旧文件夹的名字列表里移除
      const oldList = orders[oldParent];
      if (oldList) {
        const at = oldList.indexOf(oldName);
        if (at !== -1) {
          oldList.splice(at, 1);
          if (!oldList.length) delete orders[oldParent];
          this.saveSoon();
        }
      }
    }

    // 2) 文件夹改名/移动：把它的整棵子树顺序映射到新路径
    if (Array.isArray(file.children)) {
      const oldPrefix = oldPath + '/';
      const newPrefix = file.path + '/';
      const moved = {};
      for (const key of Object.keys(orders)) {
        if (key === oldPath || key.startsWith(oldPrefix)) {
          const target = key === oldPath ? file.path : newPrefix + key.slice(oldPrefix.length);
          moved[target] = orders[key];
          delete orders[key];
        }
      }
      if (Object.keys(moved).length) {
        Object.assign(orders, moved);
        this.saveSoon();
      }
    }

    this.refreshView();
  }

  handleDelete(file) {
    if (!file || !file.path) return;
    const orders = this.data.orders;
    const parentPath = file.parent ? file.parent.path : ROOT_PATH;
    const name = file.name;
    let changed = false;

    const list = orders[parentPath];
    if (list) {
      const at = list.indexOf(name);
      if (at !== -1) {
        list.splice(at, 1);
        if (!list.length) delete orders[parentPath];
        changed = true;
      }
    }

    const prefix = file.path + '/';
    for (const key of Object.keys(orders)) {
      if (key === file.path || key.startsWith(prefix)) {
        delete orders[key];
        changed = true;
      }
    }

    if (changed) {
      this.saveSoon();
      this.refreshView();
    }
  }

  /* ------------------------------ 拖拽手柄 ------------------------------ */

  setupObserver() {
    this.observedContainers.forEach((el) => {
      try {
        if (this.observer) this.observer.unobserve(el);
      } catch (e) {
        /* ignore */
      }
    });
    this.observedContainers.clear();

    if (!this.observer) {
      this.observer = new MutationObserver(() => this.decorateSoon());
    }

    for (const view of this.views) {
      const container = view.containerEl;
      if (!container || this.observedContainers.has(container)) continue;
      this.observer.observe(container, { childList: true, subtree: true });
      this.observedContainers.add(container);
    }
  }

  stopObserver() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.observedContainers.clear();
    if (this.decorateFrame) {
      window.cancelAnimationFrame(this.decorateFrame);
      this.decorateFrame = null;
    }
  }

  decorateSoon() {
    if (this.decorateFrame) return;
    this.decorateFrame = window.requestAnimationFrame(() => {
      this.decorateFrame = null;
      this.decorateNow();
    });
  }

  decorateNow() {
    const views = this.views.length ? this.views : this.getViews();
    for (const view of views) {
      const container = view.containerEl;
      if (!container) continue;

      if (!this.settings.enabled || !this.settings.showGrip) {
        container.querySelectorAll('.cfo-grip').forEach((el) => el.remove());
        continue;
      }

      const titles = container.querySelectorAll('.nav-file-title, .nav-folder-title');
      for (const title of titles) {
        // 库根目录那一行不能拖动，跳过
        const parent = title.parentElement;
        if (parent && parent.classList && parent.classList.contains('mod-root')) continue;
        if (!title.querySelector(':scope > .cfo-grip')) this.addGrip(title);
      }
    }
  }

  addGrip(titleEl) {
    const grip = document.createElement('div');
    grip.className = 'cfo-grip';
    grip.setAttribute('aria-label', '拖动以调整顺序');
    grip.setAttribute('draggable', 'false');
    paintIcon(grip, GRIP_ICON);

    // 手柄上的点击不能触发「打开文件」
    const swallow = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    grip.addEventListener('click', swallow);
    grip.addEventListener('dblclick', swallow);

    titleEl.prepend(grip);
  }

  removeGrips() {
    for (const view of this.views || []) {
      if (view.containerEl) view.containerEl.querySelectorAll('.cfo-grip').forEach((el) => el.remove());
    }
    document.querySelectorAll('.cfo-grip').forEach((el) => el.remove());
  }

  /* ------------------------------ 拖拽实现 ------------------------------ */

  /**
   * 读取行对应的文件路径。
   * 注意：Obsidian 1.x 把 data-path 设在 `.nav-file-title` / `.nav-folder-title` 上，
   * 外层的 `.nav-file` / `.nav-folder` 并没有这个属性，所以必须往下找一层。
   */
  rowPath(row) {
    if (!row) return '';
    const own = (row.dataset && row.dataset.path) || row.getAttribute('data-path');
    if (own) return own;

    const title =
      (row.matches && row.matches('.nav-file-title, .nav-folder-title') && row) ||
      (row.querySelector && row.querySelector('.nav-file-title, .nav-folder-title'));
    if (!title) return '';
    return (title.dataset && title.dataset.path) || title.getAttribute('data-path') || '';
  }

  /**
   * 收集「与拖动行同属一个文件夹」的所有行，按屏幕纵向位置排序，并排除被拖动的那一行。
   *
   * 这里刻意不依赖 DOM 容器结构：Obsidian 1.14 把库根目录的子项放在一个**没有 class 的 div** 里
   * （不再是 `.nav-folder-children`），靠 `closest('.nav-folder-children')` 会失败并回落到行自身，
   * 于是根目录下的行永远凑不出兄弟行 —— 这正是「根目录的文件/文件夹拖不动」的原因。
   * 现在直接在整个文件浏览器视图里按「父路径相同」筛选，与嵌套层级无关。
   */
  collectSiblingRows(state) {
    const views = this.views && this.views.length ? this.views : this.getViews();

    // 只取「包含被拖动行」的那个视图，避免多个文件浏览器面板重复收集同一路径的行
    let owner = null;
    for (const view of views) {
      if (view && view.containerEl && view.containerEl.contains && view.containerEl.contains(state.itemEl)) {
        owner = view;
        break;
      }
    }
    const scopes = [];
    if (owner) {
      scopes.push(owner.containerEl);
    } else {
      for (const view of views) if (view && view.containerEl) scopes.push(view.containerEl);
    }
    if (!scopes.length) scopes.push(document.body || document);

    const rows = [];
    const seen = new Set();
    for (const scope of scopes) {
      if (!scope || typeof scope.querySelectorAll !== 'function') continue;
      for (const el of scope.querySelectorAll('.nav-file, .nav-folder')) {
        if (el === state.itemEl) continue;
        // 被拖动行的祖先（父文件夹）不算兄弟
        if (el.contains && el.contains(state.itemEl)) continue;
        const p = this.rowPath(el);
        if (!p || dirname(p) !== state.folderPath) continue;
        if (seen.has(p)) continue;
        seen.add(p);
        rows.push(el);
      }
    }
    rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return rows;
  }

  startReorder(ev, grip) {
    if (this.drag) this.endReorder(null, true);

    const titleEl = grip.parentElement;
    const itemEl = titleEl && titleEl.closest('.nav-file, .nav-folder');
    if (!itemEl) {
      this.debugRecord('start-failed', { reason: 'no-item-el', target: describeChain(grip) });
      return;
    }

    const path = this.rowPath(itemEl) || this.rowPath(titleEl);
    if (!path) {
      console.warn('[custom-file-order] 该行没有 data-path，无法拖动', itemEl);
      this.debugRecord('start-failed', { reason: 'no-path', row: itemEl.className, title: titleEl.className });
      return;
    }

    const state = {
      pointerId: ev.pointerId,
      grip,
      titleEl,
      itemEl,
      folderPath: dirname(path),
      startX: ev.clientX,
      startY: ev.clientY,
      started: false,
      index: 0,
      anchor: null,
      rootEl: null,
      indicator: null,
      prevDraggable: titleEl.draggable,
      handlers: {},
    };
    this.drag = state;

    // 暂时关掉原生拖拽，避免移动手柄时被 Obsidian 的「拖动文件」接管
    titleEl.draggable = false;

    const onMove = (e) => this.onReorderMove(e);
    const onUp = (e) => this.endReorder(e, false);
    const onCancel = (e) => this.endReorder(e, true);
    const onKey = (e) => {
      if (e.key === 'Escape') this.endReorder(e, true);
    };
    // 双保险：任何从手柄发起的原生 dragstart 都拦掉
    const onDragStart = (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.cfo-grip')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    state.handlers = { onMove, onUp, onCancel, onKey, onDragStart };

    // 关键：监听挂在 document 捕获阶段，而不是元素本身。
    // 这样即使 setPointerCapture 没生效、或鼠标已经移出手柄，也能持续收到事件。
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('dragstart', onDragStart, true);

    try {
      grip.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* 拿不到指针捕获也不影响，document 上的监听仍然有效 */
    }

    this.debugRecord('start-ok', {
      path,
      folderPath: dirname(path),
      row: itemEl.className,
      siblings: this.collectSiblingRows(state).length,
    });
  }

  onReorderMove(ev) {
    const state = this.drag;
    if (!state) return;

    if (!state.started) {
      const dx = Math.abs(ev.clientX - state.startX);
      const dy = Math.abs(ev.clientY - state.startY);
      if (dx < 3 && dy < 3) return;
      state.started = true;
      state.itemEl.classList.add('cfo-drag-item');
      state.grip.classList.add('cfo-grip-active');
      document.body.classList.add('cfo-dragging');
      this.debugRecord('drag-moving', { path: this.rowPath(state.itemEl) });
    }

    this.autoScroll(state.itemEl, ev.clientY);

    const rows = this.collectSiblingRows(state);
    if (!rows.length) {
      state.index = 0;
      this.hideIndicator(state);
      if (!state.loggedEmpty) {
        state.loggedEmpty = true;
        this.debugRecord('no-siblings', {
          path: this.rowPath(state.itemEl),
          folderPath: state.folderPath,
          parent: state.itemEl.parentElement ? state.itemEl.parentElement.className : null,
        });
      }
      return;
    }

    let index = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (ev.clientY < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }
    state.index = index;
    state.anchor = index < rows.length ? rows[index] : null;

    // 插入指示线：落在第 index 行的上边缘，或最后一行的下边缘
    const first = rows[0].getBoundingClientRect();
    const anchor =
      index < rows.length
        ? rows[index].getBoundingClientRect()
        : rows[rows.length - 1].getBoundingClientRect();
    this.showIndicator(state, index < rows.length ? anchor.top : anchor.bottom, first.left, first.width);
  }

  showIndicator(state, top, left, width) {
    if (!state.indicator) {
      const el = document.createElement('div');
      el.className = 'cfo-indicator';
      document.body.appendChild(el);
      state.indicator = el;
    }
    const el = state.indicator;
    el.style.display = 'block';
    el.style.left = `${Math.round(left)}px`;
    el.style.width = `${Math.max(24, Math.round(width))}px`;
    el.style.top = `${Math.round(top) - 1}px`;
  }

  hideIndicator(state) {
    if (state.indicator) state.indicator.style.display = 'none';
  }

  autoScroll(fromEl, clientY) {
    let el = fromEl;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const scrollable = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (scrollable) {
        const rect = el.getBoundingClientRect();
        const pad = 40;
        if (clientY < rect.top + pad) el.scrollTop -= 16;
        else if (clientY > rect.bottom - pad) el.scrollTop += 16;
        return;
      }
      el = el.parentElement;
    }
  }

  endReorder(ev, cancelled) {
    const state = this.drag;
    if (!state) return;
    this.drag = null;

    const { grip, itemEl, titleEl, handlers } = state;
    document.removeEventListener('pointermove', handlers.onMove, true);
    document.removeEventListener('pointerup', handlers.onUp, true);
    document.removeEventListener('pointercancel', handlers.onCancel, true);
    document.removeEventListener('keydown', handlers.onKey, true);
    document.removeEventListener('dragstart', handlers.onDragStart, true);
    try {
      grip.releasePointerCapture(state.pointerId);
    } catch (e) {
      /* ignore */
    }

    if (state.indicator) {
      state.indicator.remove();
      state.indicator = null;
    }
    itemEl.classList.remove('cfo-drag-item');
    grip.classList.remove('cfo-grip-active');
    document.body.classList.remove('cfo-dragging');
    titleEl.draggable = state.prevDraggable !== false;

    if (cancelled || !state.started) {
      if (cancelled && state.started) this.debugRecord('end-cancelled', { path: this.rowPath(itemEl) });
      return;
    }

    const name = basename(this.rowPath(itemEl));
    if (!name) {
      this.debugRecord('end-no-name', { row: itemEl.className });
      return;
    }

    const others = this.collectSiblingRows(state)
      .map((el) => basename(this.rowPath(el)))
      .filter(Boolean);
    if (!others.length) {
      this.debugRecord('end-no-siblings', { name, folderPath: state.folderPath });
      return;
    }

    // 以「已经保存的顺序」为基础，而不是当前 DOM 顺序：
    // 这样连续拖动时，上一次的结果会立刻成为下一次的基准，不会被旧 DOM 覆盖。
    const members = new Set(others);
    members.add(name);
    const saved = (this.data.orders[state.folderPath] || []).filter((n) => members.has(n));
    const seen = new Set(saved);
    const ordered = saved.slice();
    for (const n of members) if (!seen.has(n)) ordered.push(n);

    const rest = ordered.filter((n) => n !== name);

    let at;
    if (state.anchor) {
      const anchorName = basename(this.rowPath(state.anchor));
      const pos = anchorName ? rest.indexOf(anchorName) : -1;
      at = pos === -1 ? state.index : pos;
    } else {
      at = rest.length;
    }
    at = Math.max(0, Math.min(at, rest.length));
    rest.splice(at, 0, name);

    this.setOrder(state.folderPath, rest);
    this.debugRecord('drop-saved', {
      folderPath: state.folderPath,
      name,
      index: rest.indexOf(name),
      order: rest,
    });

    // 立刻把这一行挪到位：展开的子文件夹不会被 requestSort 重排，
    // 只能自己动手，否则松手后会「弹回原位」，看起来像拖不动。
    const parent = itemEl.parentElement;
    if (parent) {
      if (state.anchor && state.anchor.parentElement === parent) {
        parent.insertBefore(itemEl, state.anchor);
      } else {
        parent.appendChild(itemEl);
      }
    }

    this.refreshView(state.folderPath);
    this.decorateSoon();
  }
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                            */
/* ------------------------------------------------------------------ */

class CustomFileOrderSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: '自定义文件排序' });

    new Setting(containerEl)
      .setName('启用自定义排序')
      .setDesc('关闭后立即恢复 Obsidian 原生的排序方式，已保存的顺序不会被删除。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.persist();
          this.plugin.refreshView();
          this.plugin.decorateSoon();
        })
      );

    new Setting(containerEl)
      .setName('显示拖拽手柄')
      .setDesc('在文件与文件夹左侧显示 ⠿ 手柄，按住手柄上下拖动即可调整顺序。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showGrip).onChange(async (value) => {
          this.plugin.settings.showGrip = value;
          await this.plugin.persist();
          this.plugin.decorateSoon();
        })
      );

    new Setting(containerEl)
      .setName('写入诊断日志')
      .setDesc('排查拖拽问题时打开：会把拖拽过程写入库根目录的 .cfo-debug.json（平时无需开启）。')
      .addToggle((toggle) =>
        toggle.setValue(!!this.plugin.settings.debug).onChange(async (value) => {
          this.plugin.settings.debug = value;
          await this.plugin.persist();
        })
      );

    containerEl.createEl('h3', { text: '使用方式' });
    const tips = containerEl.createEl('ul');
    tips.createEl('li', { text: '拖动文件行左侧的 ⠿ 手柄上下移动，松手即保存。' });
    tips.createEl('li', { text: '右键文件或文件夹 →「自定义排序」，可上移、下移、置顶、置底。' });
    tips.createEl('li', { text: '命令面板中的「自定义排序」系列命令可绑定快捷键。' });
    tips.createEl('li', { text: '每个文件夹各自独立保存顺序；新文件默认排在末尾。' });
    tips.createEl('li', { text: '「重置本文件夹顺序」会恢复该文件夹的原生排序。' });

    const count = Object.keys(this.plugin.data.orders).length;
    containerEl.createEl('h3', { text: '数据' });
    containerEl.createEl('p', {
      text: `当前共有 ${count} 个文件夹保存了自定义顺序。`,
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('清空全部排序数据')
      .setDesc('删除所有文件夹的自定义顺序，此操作不可撤销。')
      .addButton((btn) =>
        btn
          .setButtonText('清空')
          .setWarning()
          .onClick(async () => {
            this.plugin.data.orders = {};
            await this.plugin.persist();
            this.plugin.refreshView();
            new Notice('已清空全部自定义排序');
            this.display();
          })
      );
  }
}

module.exports = CustomFileOrderPlugin;
