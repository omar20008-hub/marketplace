import { Button, Card, FootNote, Input, SectionLabel } from "@/components/ds";
import { prisma } from "@/lib/db";
import { removeProduct } from "@/server/admin-actions";

/**
 * Every product on the platform, with what depends on it. A product is removed by
 * typing its slug; the server refuses while anyone has installed it, run it, or it
 * still has a submission, and says how many (see removeProduct).
 */
export async function ProductsAdmin({
  saved,
  error,
  product,
  installs,
  runs,
  submissions,
}: {
  saved?: string;
  error?: string;
  product?: string;
  installs?: string;
  runs?: string;
  submissions?: string;
}) {
  const products = await prisma.product.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      _count: { select: { installations: true, runs: true, submissions: true } },
    },
  });

  return (
    <div className="mt-5 flex flex-col gap-4">
      <SectionLabel>Products</SectionLabel>
      <FootNote>
        Removing a product deletes its record. The n8n template is not touched here: archive
        it in n8n as well. A product that someone has installed, run or submitted cannot be
        removed; remove those copies first.
      </FootNote>

      {saved ? <FootNote>Removed {saved}.</FootNote> : null}
      {error === "confirm" ? (
        <FootNote>The slug did not match {product}. Nothing was removed.</FootNote>
      ) : null}
      {error === "in_use" ? (
        <FootNote>
          {product} is still in use: {installs} installation(s), {runs} run(s), {submissions}{" "}
          submission(s). Nothing was removed.
        </FootNote>
      ) : null}
      {error === "unknown" ? <FootNote>That product no longer exists.</FootNote> : null}

      {products.map((item) => {
        const inUse = item._count.installations + item._count.runs + item._count.submissions > 0;
        return (
          <Card key={item.id} className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm font-medium">{item.title}</div>
              <div className="text-xs text-ink-3">
                {item.slug} · {item.status.toLowerCase()} · {item._count.installations} installed ·{" "}
                {item._count.runs} runs · {item._count.submissions} submissions
              </div>
            </div>

            {inUse ? (
              <FootNote>In use, so it cannot be removed.</FootNote>
            ) : (
              <form action={removeProduct} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="productId" value={item.id} />
                <Input
                  name="confirm"
                  autoComplete="off"
                  placeholder={`Type ${item.slug} to confirm`}
                  className="min-w-0 flex-1"
                  required
                />
                <Button type="submit" tone="danger" size="sm">
                  Remove product
                </Button>
              </form>
            )}
          </Card>
        );
      })}
    </div>
  );
}
