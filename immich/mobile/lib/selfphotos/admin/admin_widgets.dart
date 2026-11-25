// SelfPhotos: Memento admin's shared pieces: the entry on the Settings page (one line in
// Immich's settings.page.dart per layout), dialogs for a whole number and for a new
// password, the error text for a failed action, and a small notice line. Data:
// admin.service.dart.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/selfphotos/admin/admin.page.dart';
import 'package:immich_mobile/utils/error_handler.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:openapi/api.dart';

const _title = 'Memento admin';

void _open(BuildContext context) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AdminPage()));

/// The Settings page's card (phones), for admins only.
class MementoAdminCard extends ConsumerWidget {
  const MementoAdminCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!(ref.watch(currentUserProvider)?.isAdmin ?? false)) {
      return const SizedBox.shrink();
    }
    return SettingsCard(
      icon: Icons.admin_panel_settings_outlined,
      title: _title,
      subtitle: 'People, storage, AI edits and Memento features',
      onTap: () => _open(context),
    );
  }
}

/// The Settings page's list entry (tablets), for admins only.
class MementoAdminTile extends ConsumerWidget {
  const MementoAdminTile({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!(ref.watch(currentUserProvider)?.isAdmin ?? false)) {
      return const SizedBox.shrink();
    }
    return ListTile(
      title: const Text(_title),
      leading: const Icon(Icons.admin_panel_settings_outlined),
      onTap: () => _open(context),
    );
  }
}

/// What went wrong with an admin action: Immich's own words when it gave any ("Email is not
/// available"), its "can't reach the server" text for a dropped connection, or the message
/// from Memento's service. Never ApiException's own text, which can carry a stack trace.
String adminError(BuildContext context, Object error) {
  if (error is ApiException) {
    return serverErrorMessage(error) ?? context.t.login_form_server_error;
  }
  return error.toString();
}

/// Asks for a whole number from [min] to [max]. Pops with the number, or with -1 when
/// [resetText] is given and chosen (e.g. "Everyone's default"). Like Immich's passkey name
/// dialog: the dialog owns its text controller.
class NumberDialog extends StatefulWidget {
  final String title;
  final int value;
  final int min;
  final int max;
  final String? resetText;

  const NumberDialog({
    super.key,
    required this.title,
    required this.value,
    required this.min,
    required this.max,
    this.resetText,
  });

  @override
  State<NumberDialog> createState() => _NumberDialogState();
}

class _NumberDialogState extends State<NumberDialog> {
  late final _controller = TextEditingController(text: '${widget.value}');
  final _form = GlobalKey<FormState>();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _save() {
    if (_form.currentState?.validate() ?? false) {
      Navigator.pop(context, int.parse(_controller.text));
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      scrollable: true,
      title: Text(widget.title),
      content: Form(
        key: _form,
        child: ImmichTextInput(
          controller: _controller,
          autofocus: true,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          hintText: '${widget.min}–${widget.max}',
          validator: (text) => wholeNumberError(text, widget.min, widget.max),
          onSubmit: (_) => _save(),
        ),
      ),
      actions: [
        if (widget.resetText != null)
          TextButton(onPressed: () => Navigator.pop(context, -1), child: Text(widget.resetText!)),
        TextButton(onPressed: () => Navigator.pop(context), child: Text(context.t.cancel)),
        TextButton(onPressed: _save, child: Text(context.t.save)),
      ],
    );
  }
}

/// "1 to 100000" when [text] isn't a whole number in that range, else null.
String? wholeNumberError(String? text, int min, int max) {
  final value = int.tryParse(text ?? '');
  return value == null || value < min || value > max ? '$min to $max' : null;
}

/// Shows a new password once, to pass on to the person. It isn't stored or shown again, so
/// the dialog can't be closed by accident (back button, tapping outside).
class PasswordOnceDialog extends StatelessWidget {
  final String name;
  final String password;
  final bool isAdmin; // Immich doesn't make admins choose their own at login

  const PasswordOnceDialog({super.key, required this.name, required this.password, required this.isAdmin});

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      child: AlertDialog(
        title: Text('Password for $name'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectableText(password, style: context.textTheme.titleLarge?.copyWith(fontFamily: 'monospace')),
            const SizedBox(height: 12),
            Text(
              isAdmin
                  ? "Send it to them privately. It's shown only this once. Admins aren't asked to change it, "
                        'so ask them to choose their own in Account settings.'
                  : "Send it to them privately. It's shown only this once, and they'll be asked to choose "
                        'their own when they next log in.',
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: password));
              if (context.mounted) {
                ImmichToast.show(context: context, msg: context.t.copied_to_clipboard);
              }
            },
            child: Text(context.t.copy_password),
          ),
          TextButton(onPressed: () => Navigator.pop(context), child: Text(context.t.done)),
        ],
      ),
    );
  }
}

/// A small line under a section when something couldn't be loaded.
/// A settings switch (the app's SettingsSwitchListTile) saved as soon as it's flipped, for
/// Memento admin's switches and the person's themed memories. It can't be flipped again while
/// saving, flips back when [save] says it failed (save shows why), and follows [value] when
/// the page loads again.
class SavedSwitchTile extends HookWidget {
  final bool value;
  final String title;
  final String? subtitle;
  final bool enabled;
  final Future<bool> Function(bool wanted) save;

  const SavedSwitchTile({
    super.key,
    required this.value,
    required this.title,
    this.subtitle,
    this.enabled = true,
    required this.save,
  });

  @override
  Widget build(BuildContext context) {
    final on = useState(value);
    final saving = useState(false);
    useEffect(() {
      on.value = value;
      return null;
    }, [value]);
    return SettingsSwitchListTile(
      valueNotifier: on,
      title: title,
      subtitle: subtitle,
      enabled: enabled && !saving.value,
      onChanged: (wanted) async {
        saving.value = true;
        final saved = await save(wanted);
        if (!context.mounted) {
          return; // the page was left while saving
        }
        saving.value = false;
        if (!saved) {
          on.value = !wanted;
        }
      },
    );
  }
}

class AdminNotice extends StatelessWidget {
  final String text;

  const AdminNotice(this.text, {super.key});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
    child: Text(text, style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant)),
  );
}
