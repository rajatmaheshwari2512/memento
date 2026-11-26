// SelfPhotos: Memento admin, adding a person: name, email and storage limit.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/admin/admin.service.dart';
import 'package:immich_mobile/selfphotos/admin/admin_widgets.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_ui/immich_ui.dart';

const _maxGib = 100000;

class AdminAddUserPage extends ConsumerStatefulWidget {
  const AdminAddUserPage({super.key});

  @override
  ConsumerState<AdminAddUserPage> createState() => _AdminAddUserPageState();
}

class _AdminAddUserPageState extends ConsumerState<AdminAddUserPage> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _quota = TextEditingController();
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _quota.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    setState(() => _saving = true);
    final name = _name.text.trim();
    final password = newPassword();
    final quota = _quota.text.trim();
    try {
      await ref
          .read(adminServiceProvider)
          .createUser(
            name: name,
            email: _email.text.trim(),
            password: password,
            quotaBytes: quota.isEmpty ? null : int.parse(quota) * gib,
          );
      if (!mounted) {
        return;
      }
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => PasswordOnceDialog(name: name, password: password, isAdmin: false),
      );
      if (mounted) {
        Navigator.of(context).pop();
      }
    } catch (error) {
      if (mounted) {
        setState(() => _saving = false);
        ImmichToast.show(context: context, msg: adminError(context, error), toastType: ToastType.error);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_saving,
      child: Scaffold(
        appBar: AppBar(title: Text(context.t.create_user)),
        body: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            ImmichForm(
              onSubmit: _create,
              submitText: context.t.create_user,
              submitIcon: Icons.person_add_alt_1_outlined,
              builder: (context, form) => Column(
                spacing: ImmichSpacing.md,
                children: [
                  ImmichTextInput(
                    controller: _name,
                    label: context.t.name,
                    autofocus: true,
                    keyboardAction: TextInputAction.next,
                    validator: (text) => (text ?? '').trim().isEmpty ? context.t.name : null,
                  ),
                  ImmichEmailInput(
                    controller: _email,
                    label: context.t.email,
                    keyboardAction: TextInputAction.next,
                    validator: (text) => (text ?? '').contains('@') ? null : context.t.login_form_err_invalid_email,
                  ),
                  ImmichTextInput(
                    controller: _quota,
                    label: context.t.admin.quota_size_gib,
                    hintText: context.t.unlimited,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    validator: (text) => (text ?? '').trim().isEmpty ? null : wholeNumberError(text, 1, _maxGib),
                    onSubmit: (_) => form.submit(),
                  ),
                  const Text(
                    "A password is made for them and shown once, for you to send them; they'll choose their "
                    'own when they first log in. To make them an admin, open them afterwards.',
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
