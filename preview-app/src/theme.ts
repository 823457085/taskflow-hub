import { theme as antdTheme, type ThemeConfig } from 'antd';

export type TaskFlowThemeId =
  | 'cursor'
  | 'linear'
  | 'vercel'
  | 'raycast'
  | 'supabase'
  | 'supabase-dark'
  | 'acid'
  | 'corporate';

export interface TaskFlowThemeMeta {
  id: TaskFlowThemeId;
  label: string;
  subtitle: string;
  badge: string;
  dark: boolean;
  swatch: [string, string, string];
  telemetry: string;
  bg: string;
  stageBg: string;
  headerBg: string;
  siderBg: string;
  surface: string;
  raised: string;
  border: string;
  divider: string;
  text: string;
  secondary: string;
  muted: string;
  primary: string;
  primaryHover: string;
  onPrimary: string;
  accent: string;
  accentSoft: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  error: string;
  errorBg: string;
  radiusCard: number;
  radiusControl: number;
  shadowCard: string;
  shadowFloat: string;
}

export const TASKFLOW_THEME_STORAGE_KEY = 'taskflow.theme.v1';
export const DEFAULT_TASKFLOW_THEME: TaskFlowThemeId = 'cursor';

export const TASKFLOW_THEMES: readonly TaskFlowThemeMeta[] = [
  {
    id: 'cursor',
    label: 'Cursor 暖纸',
    subtitle: '暖米纸层 · 社论排版 · 陶橙焦点',
    badge: 'PAPER SHEETS',
    dark: false,
    swatch: ['#f7f7f4', '#ffffff', '#d04200'],
    telemetry: 'CREAM FLOOR · EDITORIAL 400 · TERRACOTTA CTA',
    bg: '#f2f1ed',
    stageBg: '#f7f7f4',
    headerBg: '#f7f7f4',
    siderBg: '#f7f7f4',
    surface: '#ffffff',
    raised: '#f5f4f0',
    border: '#e5e3dc',
    divider: '#eceae3',
    text: '#26251e',
    secondary: '#57554d',
    muted: '#7a776e',
    primary: '#d04200',
    primaryHover: '#b53800',
    onPrimary: '#ffffff',
    accent: '#c23d00',
    accentSoft: 'rgba(208, 66, 0, 0.09)',
    success: '#15803d',
    successBg: 'rgba(21, 128, 61, 0.09)',
    warning: '#b45309',
    warningBg: 'rgba(180, 83, 9, 0.10)',
    error: '#dc2626',
    errorBg: 'rgba(220, 38, 38, 0.09)',
    radiusCard: 12,
    radiusControl: 8,
    shadowCard: '0 1px 2px rgba(38, 37, 30, 0.04), 0 8px 24px -12px rgba(38, 37, 30, 0.08)',
    shadowFloat: '0 24px 64px -16px rgba(38, 37, 30, 0.20)',
  },
  {
    id: 'linear',
    label: 'Linear 暗夜',
    subtitle: '纯黑外框 · 内嵌画布 · 靛紫高光',
    badge: 'INSET CANVAS',
    dark: true,
    swatch: ['#010102', '#0f1011', '#5e6ad2'],
    telemetry: 'INSET CANVAS · 4-STEP SURFACE LADDER · INDIGO CTA',
    bg: '#010102',
    stageBg: '#08090a',
    headerBg: '#010102',
    siderBg: '#010102',
    surface: '#0f1011',
    raised: '#16181a',
    border: '#23252a',
    divider: '#1b1d21',
    text: '#f7f8f8',
    secondary: '#b4bcd0',
    muted: '#8a8f98',
    primary: '#5e6ad2',
    primaryHover: '#6e79de',
    onPrimary: '#ffffff',
    accent: '#7a85e8',
    accentSoft: 'rgba(94, 106, 210, 0.16)',
    success: '#4cb782',
    successBg: 'rgba(76, 183, 130, 0.14)',
    warning: '#f2994a',
    warningBg: 'rgba(242, 153, 74, 0.15)',
    error: '#eb5757',
    errorBg: 'rgba(235, 87, 87, 0.15)',
    radiusCard: 12,
    radiusControl: 8,
    shadowCard: '0 0 0 1px rgba(255, 255, 255, 0.03), 0 10px 28px -14px rgba(0, 0, 0, 0.65)',
    shadowFloat: '0 28px 72px -12px rgba(0, 0, 0, 0.78)',
  },
  {
    id: 'vercel',
    label: 'Vercel 极简',
    subtitle: '顶栏底线 · 发丝阴影 · 纯墨焦点',
    badge: 'TOP TABS',
    dark: false,
    swatch: ['#ffffff', '#fafafa', '#171717'],
    telemetry: 'SHADOW-AS-BORDER · GEIST HAIRLINE · INK PRIMARY',
    bg: '#fafafa',
    stageBg: '#fafafa',
    headerBg: '#ffffff',
    siderBg: '#ffffff',
    surface: '#ffffff',
    raised: '#f4f4f5',
    border: '#eaeaea',
    divider: '#f0f0f0',
    text: '#171717',
    secondary: '#4d4d4d',
    muted: '#666666',
    primary: '#171717',
    primaryHover: '#333333',
    onPrimary: '#ffffff',
    accent: '#0070f3',
    accentSoft: 'rgba(0, 112, 243, 0.09)',
    success: '#0d9488',
    successBg: 'rgba(13, 148, 136, 0.09)',
    warning: '#d97706',
    warningBg: 'rgba(217, 119, 6, 0.10)',
    error: '#e11d48',
    errorBg: 'rgba(225, 29, 72, 0.09)',
    radiusCard: 10,
    radiusControl: 6,
    shadowCard: '0 0 0 1px rgba(0, 0, 0, 0.06), 0 2px 6px rgba(0, 0, 0, 0.03)',
    shadowFloat: '0 0 0 1px rgba(0, 0, 0, 0.08), 0 24px 60px rgba(0, 0, 0, 0.16)',
  },
  {
    id: 'raycast',
    label: 'Raycast 指令',
    subtitle: '等距悬浮舱 · 顶部高光 · 纯白胶囊',
    badge: 'FLOATING PANELS',
    dark: true,
    swatch: ['#07080a', '#111216', '#ffffff'],
    telemetry: 'FLOATING COMMAND PANELS · INSET HIGHLIGHT · WHITE CTA',
    bg: '#07080a',
    stageBg: '#111216',
    headerBg: '#111216',
    siderBg: '#111216',
    surface: '#16181d',
    raised: '#1d2026',
    border: '#272a33',
    divider: '#1f222a',
    text: '#f4f5f8',
    secondary: '#b5bac6',
    muted: '#858b99',
    primary: '#ffffff',
    primaryHover: '#e5e7eb',
    onPrimary: '#0b0c0e',
    accent: '#ff6363',
    accentSoft: 'rgba(255, 99, 99, 0.15)',
    success: '#3dd68c',
    successBg: 'rgba(61, 214, 140, 0.14)',
    warning: '#f5a623',
    warningBg: 'rgba(245, 166, 35, 0.15)',
    error: '#ff6363',
    errorBg: 'rgba(255, 99, 99, 0.16)',
    radiusCard: 12,
    radiusControl: 8,
    shadowCard: 'inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 12px 32px -12px rgba(0, 0, 0, 0.65)',
    shadowFloat: 'inset 0 1px 0 rgba(255, 255, 255, 0.09), 0 28px 72px rgba(0, 0, 0, 0.82)',
  },
  {
    id: 'supabase',
    label: 'Supabase 翠绿',
    subtitle: '精密控制台 · 工程圆角 · 翠绿深字',
    badge: 'CONSOLE',
    dark: false,
    swatch: ['#fafafa', '#ffffff', '#3ecf8e'],
    telemetry: 'DASHBOARD CONSOLE · EMERALD CTA · 6PX ENGINEERING',
    bg: '#f5f6f7',
    stageBg: '#fafafa',
    headerBg: '#ffffff',
    siderBg: '#ffffff',
    surface: '#ffffff',
    raised: '#f3f4f6',
    border: '#e2e5e9',
    divider: '#eceef1',
    text: '#171717',
    secondary: '#4b5563',
    muted: '#6b7280',
    primary: '#3ecf8e',
    primaryHover: '#34b87c',
    onPrimary: '#0f1714',
    accent: '#15803d',
    accentSoft: 'rgba(62, 207, 142, 0.15)',
    success: '#15803d',
    successBg: 'rgba(21, 128, 61, 0.10)',
    warning: '#b45309',
    warningBg: 'rgba(180, 83, 9, 0.10)',
    error: '#dc2626',
    errorBg: 'rgba(220, 38, 38, 0.09)',
    radiusCard: 8,
    radiusControl: 6,
    shadowCard: '0 1px 2px rgba(17, 24, 28, 0.04)',
    shadowFloat: '0 24px 64px rgba(17, 24, 28, 0.16)',
  },
  {
    id: 'supabase-dark',
    label: 'Supabase 夜间',
    subtitle: '暗夜控制台 · 1px 线框定深 · 翠绿按钮',
    badge: 'CONSOLE',
    dark: true,
    swatch: ['#171717', '#1c1c1c', '#3ecf8e'],
    telemetry: 'DARK CONSOLE · 1PX BORDER DEPTH · EMERALD CTA',
    bg: '#121212',
    stageBg: '#171717',
    headerBg: '#171717',
    siderBg: '#171717',
    surface: '#1c1c1c',
    raised: '#242424',
    border: '#2e2e2e',
    divider: '#262626',
    text: '#ededed',
    secondary: '#b4b4b4',
    muted: '#898989',
    primary: '#3ecf8e',
    primaryHover: '#4edb9b',
    onPrimary: '#0f1714',
    accent: '#3ecf8e',
    accentSoft: 'rgba(62, 207, 142, 0.15)',
    success: '#3ecf8e',
    successBg: 'rgba(62, 207, 142, 0.14)',
    warning: '#f59e0b',
    warningBg: 'rgba(245, 158, 11, 0.15)',
    error: '#f87171',
    errorBg: 'rgba(248, 113, 113, 0.15)',
    radiusCard: 8,
    radiusControl: 6,
    shadowCard: 'none',
    shadowFloat: '0 28px 72px rgba(0, 0, 0, 0.78)',
  },
  {
    id: 'acid',
    label: '酸性荧光',
    subtitle: '硬核直角 · 荧光绿高反差 · 赛博网格',
    badge: 'HOLY GRAIL',
    dark: true,
    swatch: ['#090a0c', '#121417', '#39ff14'],
    telemetry: 'ACID GRAPHICS · ZERO RADIUS · NEON 39FF14',
    bg: '#070809',
    stageBg: '#0b0d0f',
    headerBg: '#090a0c',
    siderBg: '#090a0c',
    surface: '#111418',
    raised: '#181c22',
    border: '#2a3038',
    divider: '#20252c',
    text: '#f4f7fa',
    secondary: '#c2cbd6',
    muted: '#8c97a6',
    primary: '#39ff14',
    primaryHover: '#62ff45',
    onPrimary: '#050805',
    accent: '#39ff14',
    accentSoft: 'rgba(57, 255, 20, 0.14)',
    success: '#39ff14',
    successBg: 'rgba(57, 255, 20, 0.13)',
    warning: '#e6ff00',
    warningBg: 'rgba(230, 255, 0, 0.14)',
    error: '#ff4d8d',
    errorBg: 'rgba(255, 77, 141, 0.16)',
    radiusCard: 0,
    radiusControl: 0,
    shadowCard: '3px 3px 0 rgba(57, 255, 20, 0.18)',
    shadowFloat: '6px 6px 0 rgba(57, 255, 20, 0.35)',
  },
  {
    id: 'corporate',
    label: '经典蓝白',
    subtitle: '石板雾白 · 企业深蓝 · 稳健清晰',
    badge: 'CORPORATE',
    dark: false,
    swatch: ['#f8fafc', '#ffffff', '#1e40af'],
    telemetry: 'CORPORATE CLEAN · SLATE MIST · ROYAL BLUE',
    bg: '#f1f5f9',
    stageBg: '#f8fafc',
    headerBg: '#ffffff',
    siderBg: '#ffffff',
    surface: '#ffffff',
    raised: '#f8fafc',
    border: '#e2e8f0',
    divider: '#edf2f7',
    text: '#0f172a',
    secondary: '#475569',
    muted: '#64748b',
    primary: '#1e40af',
    primaryHover: '#1e3a8a',
    onPrimary: '#ffffff',
    accent: '#1e40af',
    accentSoft: 'rgba(30, 64, 175, 0.09)',
    success: '#059669',
    successBg: 'rgba(16, 185, 129, 0.10)',
    warning: '#d97706',
    warningBg: 'rgba(217, 119, 6, 0.10)',
    error: '#dc2626',
    errorBg: 'rgba(220, 38, 38, 0.09)',
    radiusCard: 12,
    radiusControl: 8,
    shadowCard: '0 1px 2px rgba(15, 23, 42, 0.05), 0 6px 20px -12px rgba(15, 23, 42, 0.08)',
    shadowFloat: '0 24px 64px -16px rgba(15, 23, 42, 0.18)',
  },
];

export function resolveTaskFlowTheme(id?: string | null): TaskFlowThemeMeta {
  return TASKFLOW_THEMES.find(item => item.id === id) || TASKFLOW_THEMES[0];
}

export function loadTaskFlowTheme(): TaskFlowThemeId {
  try {
    const raw = localStorage.getItem(TASKFLOW_THEME_STORAGE_KEY);
    return resolveTaskFlowTheme(raw).id;
  } catch {
    return DEFAULT_TASKFLOW_THEME;
  }
}

export function saveTaskFlowTheme(id: TaskFlowThemeId): void {
  try {
    localStorage.setItem(TASKFLOW_THEME_STORAGE_KEY, id);
  } catch {
    /* Optional preference storage */
  }
}

export function applyTaskFlowThemeDom(meta: TaskFlowThemeMeta): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = meta.id;
  root.style.colorScheme = meta.dark ? 'dark' : 'light';
  const vars: Record<string, string> = {
    '--tf-bg': meta.bg,
    '--tf-stage-bg': meta.stageBg,
    '--tf-header-bg': meta.headerBg,
    '--tf-sider-bg': meta.siderBg,
    '--tf-surface': meta.surface,
    '--tf-raised': meta.raised,
    '--tf-border': meta.border,
    '--tf-divider': meta.divider,
    '--tf-text': meta.text,
    '--tf-secondary': meta.secondary,
    '--tf-muted': meta.muted,
    '--tf-primary': meta.primary,
    '--tf-primary-hover': meta.primaryHover,
    '--tf-on-primary': meta.onPrimary,
    '--tf-accent': meta.accent,
    '--tf-accent-soft': meta.accentSoft,
    '--tf-success': meta.success,
    '--tf-success-bg': meta.successBg,
    '--tf-warning': meta.warning,
    '--tf-warning-bg': meta.warningBg,
    '--tf-error': meta.error,
    '--tf-error-bg': meta.errorBg,
    '--tf-card-radius': `${meta.radiusCard}px`,
    '--tf-control-radius': `${meta.radiusControl}px`,
    '--tf-shadow-card': meta.shadowCard,
    '--tf-shadow-float': meta.shadowFloat,
    '--color-corporate-blue': meta.accent,
    '--color-corporate-blue-hover': meta.primaryHover,
    '--color-slate-mist': meta.stageBg,
    '--color-slate': meta.muted,
    '--color-text-primary': meta.text,
    '--color-border-card': meta.border,
    '--color-border-input': meta.border,
    '--radius-cards': `${meta.radiusCard}px`,
    '--radius-buttons': `${meta.radiusControl}px`,
    '--radius-inputs': `${meta.radiusControl}px`,
  };
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}

export function buildAntdThemeConfig(id: TaskFlowThemeId): ThemeConfig {
  const m = resolveTaskFlowTheme(id);
  return {
    algorithm: m.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: m.primary,
      colorInfo: m.accent,
      colorLink: m.accent,
      colorLinkHover: m.primaryHover,
      colorPrimaryHover: m.primaryHover,
      colorPrimaryActive: m.primaryHover,
      colorTextLightSolid: m.onPrimary,
      colorSuccess: m.success,
      colorWarning: m.warning,
      colorError: m.error,
      colorText: m.text,
      colorTextSecondary: m.secondary,
      colorTextTertiary: m.muted,
      colorBorder: m.border,
      colorBorderSecondary: m.divider,
      colorBgBase: m.bg,
      colorBgContainer: m.surface,
      colorBgElevated: m.surface,
      colorBgLayout: m.stageBg,
      colorBgMask: m.dark ? 'rgba(2, 4, 8, 0.62)' : 'rgba(15, 23, 42, 0.32)',
      colorFillAlter: m.raised,
      colorFillSecondary: m.raised,
      controlItemBgActive: m.accentSoft,
      borderRadius: m.radiusControl,
      borderRadiusSM: Math.max(0, m.radiusControl - 2),
      borderRadiusLG: m.radiusCard,
      controlHeight: 32,
      controlHeightSM: 26,
      controlHeightLG: 36,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif",
      fontFamilyCode: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      fontSizeSM: 12,
      fontSizeLG: 14,
      fontSizeXL: 16,
      fontSizeHeading1: 18,
      fontSizeHeading2: 15.5,
      fontSizeHeading3: 14,
      fontSizeHeading4: 13.5,
      fontSizeHeading5: 13,
      fontWeightStrong: 600,
      lineHeight: 1.55,
      lineHeightHeading1: 1.3,
      lineHeightHeading2: 1.35,
      padding: 14,
      paddingLG: 16,
      paddingSM: 10,
      paddingXS: 6,
      paddingXXS: 4,
      margin: 12,
      marginLG: 16,
      marginSM: 10,
      marginXS: 6,
      marginXXS: 4,
      boxShadow: m.shadowFloat,
      boxShadowSecondary: m.shadowCard === 'none' ? '0 1px 2px rgba(0,0,0,0.2)' : m.shadowCard,
      motionDurationFast: '0.14s',
      motionDurationMid: '0.2s',
      motionDurationSlow: '0.26s',
    },
    components: {
      Layout: {
        headerBg: m.headerBg,
        siderBg: m.siderBg,
        bodyBg: m.stageBg,
        headerHeight: 44,
        headerPadding: '0 16px',
      },
      Button: {
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
        primaryColor: m.onPrimary,
        defaultBg: m.surface,
        defaultBorderColor: m.border,
        defaultColor: m.text,
        fontWeight: 500,
        paddingInline: 12,
        paddingInlineSM: 9,
        contentFontSize: 12.5,
        contentFontSizeSM: 12,
      },
      Card: {
        headerHeight: 42,
        headerHeightSM: 38,
        headerFontSize: 13.5,
        bodyPadding: 16,
        bodyPaddingSM: 12,
        headerPadding: 16,
        headerPaddingSM: 12,
      },
      Menu: {
        itemHeight: 31,
        itemMarginBlock: 1,
        itemMarginInline: 6,
        itemPaddingInline: 10,
        itemBorderRadius: m.radiusControl,
        itemSelectedBg: id === 'vercel' ? m.raised : m.accentSoft,
        itemSelectedColor: m.text,
        itemColor: m.secondary,
        itemHoverColor: m.text,
        itemHoverBg: m.raised,
        iconSize: 14,
      },
      Input: {
        activeBorderColor: m.accent,
        hoverBorderColor: m.secondary,
        activeShadow: `0 0 0 3px ${m.accentSoft}`,
        paddingInline: 10,
      },
      Select: {
        activeBorderColor: m.accent,
        hoverBorderColor: m.secondary,
        activeOutlineColor: m.accentSoft,
        optionSelectedBg: m.accentSoft,
        optionSelectedColor: m.text,
        optionPadding: '6px 10px',
      },
      Form: {
        itemMarginBottom: 12,
        labelFontSize: 12,
        labelColor: m.secondary,
        verticalLabelPadding: '0 0 4px',
      },
      Tabs: {
        itemColor: m.muted,
        itemSelectedColor: m.text,
        itemHoverColor: m.text,
        inkBarColor: m.primary,
        horizontalItemGutter: 18,
        horizontalMargin: '0 0 12px 0',
      },
      Table: {
        headerBg: m.raised,
        headerColor: m.muted,
        headerBorderRadius: m.radiusControl,
        cellPaddingBlock: 9,
        cellPaddingInline: 12,
        cellPaddingBlockSM: 7,
        cellPaddingInlineSM: 10,
        rowHoverBg: m.raised,
        borderColor: m.divider,
      },
      Tag: {
        defaultBg: m.raised,
        defaultColor: m.secondary,
      },
      Modal: {
        contentBg: m.surface,
        headerBg: m.surface,
        titleFontSize: 15,
        titleLineHeight: 1.4,
      },
      Drawer: {
        footerPaddingBlock: 10,
        footerPaddingInline: 18,
      },
      Collapse: {
        headerBg: m.surface,
        contentBg: m.surface,
        headerPadding: '10px 14px',
        contentPadding: '0 14px 14px',
      },
      Breadcrumb: {
        itemColor: m.muted,
        lastItemColor: m.text,
        linkColor: m.muted,
        linkHoverColor: m.text,
      },
    },
  };
}

export const corporateTheme: ThemeConfig = buildAntdThemeConfig('corporate');
