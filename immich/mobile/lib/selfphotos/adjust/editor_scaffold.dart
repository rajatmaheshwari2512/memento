// SelfPhotos editor pages (Adjust, AI Edit).
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/theme.provider.dart';
import 'package:immich_mobile/theme/theme_data.dart';
import 'package:immich_ui/immich_ui.dart';

/// Immich's own words for leaving the editor with changes.
Future<bool?> confirmEditorDiscard(BuildContext context) => showDialog<bool>(
  context: context,
  builder: (context) => AlertDialog(
    title: Text(context.t.editor_discard_edits_title),
    content: Text(context.t.editor_discard_edits_prompt),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(false),
        style: ButtonStyle(foregroundColor: WidgetStateProperty.all(context.themeData.colorScheme.onSurfaceVariant)),
        child: Text(context.t.cancel),
      ),
      TextButton(onPressed: () => Navigator.of(context).pop(true), child: Text(context.t.confirm)),
    ],
  ),
);

/// The dark theme wraps the page's scaffold.
class EditorScaffold extends ConsumerWidget {
  /// The app bar's title; Immich's "Edit" when null.
  final String? title;

  /// The editor's tabs (AdjustTabs), above the tool; none when null.
  final Widget? tabs;
  final bool saving;

  /// How far the save is (0–1), or null for "busy".
  final double? progress;
  final bool canSave;
  final VoidCallback onSave;

  /// Unsaved changes: leaving asks first, then [onDiscard] runs.
  final bool hasChanges;
  final VoidCallback onDiscard;
  final Widget photo;
  final WidgetBuilder tool;
  final WidgetBuilder footer;

  /// AI Edit's panel: only as tall as its tools, up to half the screen (as on the web).
  final bool compact;

  const EditorScaffold({
    super.key,
    this.title,
    this.tabs,
    required this.saving,
    required this.canSave,
    required this.onSave,
    required this.hasChanges,
    required this.onDiscard,
    required this.photo,
    required this.tool,
    required this.footer,
    this.progress,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final darkScheme = ref.watch(immichThemeProvider).dark;
    final screen = MediaQuery.sizeOf(context).height;
    final keyboard = MediaQuery.viewInsetsOf(context).bottom;
    Widget tools = SingleChildScrollView(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
      child: Builder(builder: tool),
    );
    if (!compact || keyboard > 0) {
      tools = ConstrainedBox(
        constraints: BoxConstraints(maxHeight: (screen - keyboard) * 0.38),
        child: tools,
      );
    }
    return PopScope(
      canPop: !hasChanges && !saving,
      onPopInvokedWithResult: (didPop, result) async {
        if (didPop || saving) {
          return;
        }
        if ((await confirmEditorDiscard(context) ?? false) && context.mounted) {
          onDiscard();
          Navigator.of(context).pop(false);
        }
      },
      child: Theme(
        data: getThemeData(colorScheme: darkScheme, locale: context.locale),
        child: Scaffold(
          appBar: AppBar(
            backgroundColor: Colors.black,
            title: Text(title ?? context.t.edit),
            leading: ImmichCloseButton(onPressed: () => Navigator.of(context).maybePop()),
            actions: [
              saving
                  ? const Padding(
                      padding: EdgeInsets.all(8.0),
                      child: SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 2.5)),
                    )
                  : ImmichIconButton(
                      icon: Icons.done_rounded,
                      color: ImmichColor.primary,
                      variant: ImmichVariant.ghost,
                      disabled: !canSave,
                      onPressed: onSave,
                    ),
            ],
          ),
          backgroundColor: Colors.black,
          body: SafeArea(
            bottom: false,
            child: Column(
              children: [
                Expanded(child: photo),
                Container(
                  width: double.infinity,
                  constraints: compact ? BoxConstraints(maxHeight: screen * 0.5) : null,
                  decoration: BoxDecoration(
                    color: darkScheme.surface,
                    borderRadius: const BorderRadius.only(topLeft: Radius.circular(20), topRight: Radius.circular(20)),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (saving) LinearProgressIndicator(value: progress),
                      if (tabs case final tabs?)
                        Padding(padding: const EdgeInsets.only(left: 12, right: 12, top: 12), child: tabs),
                      compact ? Flexible(child: tools) : tools,
                      Padding(
                        padding: const EdgeInsets.only(bottom: 36, left: 24, right: 24),
                        child: Builder(builder: footer),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
