import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';

// SelfPhotos: the Memento mark, black in light mode and white in dark mode.
const mementoLogoLight = 'assets/immich-logo.png';
const mementoLogoDark = 'assets/memento-logo-dark.png';

String mementoLogoFor(BuildContext context) => context.isDarkTheme ? mementoLogoDark : mementoLogoLight;

class ImmichLogo extends StatelessWidget {
  final double size;

  const ImmichLogo({super.key, this.size = 100});

  @override
  Widget build(BuildContext context) {
    return Image(
      image: AssetImage(mementoLogoFor(context)),
      width: size,
      filterQuality: FilterQuality.high,
      isAntiAlias: true,
    );
  }
}
