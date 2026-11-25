// SelfPhotos Ask Photos on the search page (lib/presentation/pages/search/search.page.dart):
// the "Ask" search type in its menu, and the chips for how a question was read. Built from
// the page's own pieces (the menu item's look, SearchFilterChip). Not part of Immich.
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/selfphotos/ask/ask.service.dart';
import 'package:immich_mobile/selfphotos/extras_client.dart';
import 'package:immich_mobile/widgets/search/search_filter/search_filter_chip.dart';

const askSearchIcon = Icons.auto_awesome_outlined;
const askSearchHint = 'Ask anything, e.g. "Mom and me at the beach last December"';

/// The "Ask" entry of the search-type menu, like the entries next to it. Only when an admin
/// has Ask Photos on (Administration → Settings → Memento Features).
class AskSearchTypeItem extends ConsumerWidget {
  final bool selected;
  final VoidCallback onPressed;

  const AskSearchTypeItem({super.key, required this.selected, required this.onPressed});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!ref.watch(mementoFeaturesProvider).askPhotos) {
      return const SizedBox.shrink();
    }
    return MenuItemButton(
      onPressed: onPressed,
      child: ListTile(
        leading: const Icon(askSearchIcon),
        title: Text(
          'Ask',
          style: context.textTheme.bodyLarge?.copyWith(
            fontWeight: FontWeight.w500,
            color: selected ? context.colorScheme.primary : null,
          ),
        ),
        selectedColor: context.colorScheme.primary,
        selected: selected,
      ),
    );
  }
}

/// In place of the filter chips' row: the row itself, or in Ask mode, chips for how the
/// current question was read (the question sets people, dates and kinds itself) and any hints.
class AskOrFilterRow extends ConsumerWidget {
  final bool ask;
  final String? question;
  final Widget child;

  const AskOrFilterRow({super.key, required this.ask, required this.question, required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Keeps the flags loaded while the search page is open, so the menu's Ask item is ready.
    ref.watch(mementoFlagsProvider);
    if (!ask) {
      return SliverToBoxAdapter(child: child);
    }
    final read = ref.watch(askUnderstoodProvider);
    final understood = read != null && read.question == question ? read : null;
    final style = context.textTheme.labelLarge;
    final chips = [
      if (understood != null && understood.people.isNotEmpty) (Icons.people_alt_outlined, understood.people.join(', ')),
      if (understood?.dates case final dates?) (Icons.date_range_outlined, dates),
      if (understood?.place case final place?) (Icons.location_on_outlined, place),
      if (understood?.type case final type?)
        (Icons.video_collection_outlined, type == 'VIDEO' ? context.t.video : context.t.image),
      if (understood?.favorite ?? false) (Icons.favorite_border_rounded, context.t.favorite),
      if (understood?.order case final order?)
        (Icons.sort_rounded, order == 'oldest' ? context.t.oldest_first : context.t.newest_first),
      if (understood != null && understood.text.isNotEmpty) (askSearchIcon, understood.text),
    ];

    return SliverToBoxAdapter(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            height: 50,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              children: [
                for (final (icon, value) in chips)
                  SearchFilterChip(
                    icon: icon,
                    label: value,
                    currentFilter: Text(value, style: style),
                    onTap: () {},
                  ),
              ],
            ),
          ),
          for (final hint in understood?.hints ?? const <String>[])
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
              child: Text(
                hint,
                style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
              ),
            ),
        ],
      ),
    );
  }
}
